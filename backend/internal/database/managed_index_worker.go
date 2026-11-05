package database

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

// RunManagedIndexWorker serializes DDL across processes using a session advisory
// lock. The durable registry allows recovery after API/container restarts.
func RunManagedIndexWorker(ctx context.Context, db *gorm.DB) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if err := managedIndexTick(ctx, db); err != nil && ctx.Err() == nil {
			log.Printf("DB index manager: %v", err)
		}
	}
}

func managedIndexTick(ctx context.Context, db *gorm.DB) error {
	var exists bool
	if err := db.WithContext(ctx).Raw("SELECT EXISTS(SELECT 1 FROM managed_database_indexes)").Scan(&exists).Error; err != nil {
		return err
	}
	if !exists {
		return nil
	}
	opCtx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	guard, err := indexConnection(opCtx, db)
	if err != nil {
		return err
	}
	defer closeIndexSession(guard)
	var locked bool
	if err := guard.QueryRowContext(opCtx, "SELECT pg_try_advisory_lock($1)", indexWorkerLock).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return nil
	}
	conn, err := indexConnection(opCtx, db)
	if err != nil {
		return err
	}
	defer closeIndexSession(conn)
	var pending []models.ManagedDatabaseIndex
	if err := db.WithContext(opCtx).Where("status IN ?", []string{"queued", "building", "deleting"}).Order("id ASC").Find(&pending).Error; err != nil {
		return err
	}
	for _, setting := range []string{"SET statement_timeout='15min'", "SET lock_timeout='3s'"} {
		if _, err := conn.ExecContext(opCtx, setting); err != nil {
			if len(pending) > 0 {
				return indexFailure(opCtx, db, pending[0], fmt.Errorf("cannot apply mandatory DDL resource limits: %w", err))
			}
			return err
		}
	}
	if len(pending) > 0 {
		m := pending[0]
		if m.Status == "deleting" {
			if err := dropActiveIndex(opCtx, db, conn, &m); err != nil {
				return indexFailure(opCtx, db, m, err)
			}
			return db.WithContext(opCtx).Delete(&m).Error
		}
		if m.Status == "building" {
			// No other worker can own this job while we hold the advisory lock.
			// An interrupted build is cleaned up; an old ready index is preserved.
			err := discardCandidate(opCtx, db, conn, &m)
			if err != nil {
				return indexFailure(opCtx, db, m, err)
			}
			return indexFailure(opCtx, db, m, fmt.Errorf("Index build was interrupted by a restart. Edit and save to retry; the previous index, if any, is retained."))
		}
		for _, setting := range []string{"SET maintenance_work_mem='32MB'", "SET max_parallel_maintenance_workers=0"} {
			if _, err := conn.ExecContext(opCtx, setting); err != nil {
				return indexFailure(opCtx, db, m, err)
			}
		}
		var tempLimit int64
		if err := conn.QueryRowContext(opCtx, "SELECT setting::bigint FROM pg_settings WHERE name='temp_file_limit'").Scan(&tempLimit); err != nil {
			return indexFailure(opCtx, db, m, err)
		}
		if tempLimit < 0 || tempLimit > 262144 {
			if _, err := conn.ExecContext(opCtx, "SET temp_file_limit='262144kB'"); err != nil {
				return indexFailure(opCtx, db, m, fmt.Errorf("Mandatory 256 MiB temporary-file cap is unavailable: %w", err))
			}
		}
		return buildManagedIndex(opCtx, db, conn, m)
	}
	return enforceManagedIndexBudgets(opCtx, db, conn)
}

func indexFailure(ctx context.Context, db *gorm.DB, m models.ManagedDatabaseIndex, err error) error {
	message := err.Error()
	if len(message) > 500 {
		message = message[:500]
	}
	return db.WithContext(ctx).Model(&models.ManagedDatabaseIndex{}).Where("id=?", m.ID).Updates(map[string]any{"status": "failed", "message": message}).Error
}

func findCatalogIndex(ctx context.Context, db *gorm.DB, name string) (*IndexCatalogEntry, error) {
	catalog, err := readIndexCatalog(ctx, db)
	if err != nil {
		return nil, err
	}
	for _, c := range catalog {
		if c.Name == name {
			return &c, nil
		}
	}
	return nil, nil
}

func claimCandidate(ctx context.Context, db *gorm.DB, conn *indexSession, m *models.ManagedDatabaseIndex) (*IndexCatalogEntry, error) {
	if m.CandidateName == "" {
		return nil, nil
	}
	c, err := findCatalogIndex(ctx, db, m.CandidateName)
	if err != nil || c == nil {
		return c, err
	}
	if !candidateMatches(*c, *m) {
		return nil, ErrIndexProtected
	}
	if m.CandidateDefinition != "" && (c.Definition != m.CandidateDefinition || c.OID != m.CandidateOID) {
		return nil, ErrIndexProtected
	}
	if _, err := conn.ExecContext(ctx, "COMMENT ON INDEX "+quoteIdentifier(c.Schema)+"."+quoteIdentifier(c.Name)+" IS "+quoteLiteral("acs-ui-index:"+m.CandidateToken)); err != nil {
		return nil, err
	}
	c.Comment = "acs-ui-index:" + m.CandidateToken
	m.CandidateOID = c.OID
	m.CandidateDefinition = c.Definition
	if err := db.WithContext(ctx).Model(m).Updates(map[string]any{"candidate_oid": c.OID, "candidate_definition": c.Definition}).Error; err != nil {
		return nil, err
	}
	return c, nil
}

func discardCandidate(ctx context.Context, db *gorm.DB, conn *indexSession, m *models.ManagedDatabaseIndex) error {
	c, err := claimCandidate(ctx, db, conn, m)
	if err != nil {
		return err
	}
	if c != nil {
		if !indexOwned(*c, m.CandidateName, m.CandidateOID, m.CandidateDefinition, m.CandidateToken) {
			return ErrIndexProtected
		}
		if _, err := conn.ExecContext(ctx, "DROP INDEX CONCURRENTLY "+quoteIdentifier(c.Schema)+"."+quoteIdentifier(c.Name)); err != nil {
			return err
		}
	}
	m.CandidateName = ""
	m.CandidateOID = 0
	m.CandidateToken = ""
	m.CandidateDefinition = ""
	return db.WithContext(ctx).Model(m).Updates(map[string]any{"candidate_name": "", "candidate_oid": 0, "candidate_token": "", "candidate_definition": "", "cancel_requested": false}).Error
}

func dropActiveIndex(ctx context.Context, db *gorm.DB, conn *indexSession, m *models.ManagedDatabaseIndex) error {
	if m.ActiveName == "" {
		return nil
	}
	c, err := findCatalogIndex(ctx, db, m.ActiveName)
	if err != nil {
		return err
	}
	if c != nil {
		if !indexOwned(*c, m.ActiveName, m.ActiveOID, m.ActiveDefinition, m.ActiveToken) {
			return ErrIndexProtected
		}
		if _, err := conn.ExecContext(ctx, "DROP INDEX CONCURRENTLY "+quoteIdentifier(c.Schema)+"."+quoteIdentifier(c.Name)); err != nil {
			return err
		}
	}
	m.ActiveName = ""
	m.ActiveOID = 0
	m.ActiveDefinition = ""
	m.ActiveToken = ""
	return db.WithContext(ctx).Model(m).Updates(map[string]any{"active_name": "", "active_oid": 0, "active_definition": "", "active_token": ""}).Error
}

func buildBudgetError(b IndexBudget) error {
	if !b.ProbeFresh {
		return fmt.Errorf("Storage measurement is missing or stale; index construction is blocked.")
	}
	if b.FreeBytes-b.ReserveBytes < 3*ManagedIndexMaxBytes {
		return fmt.Errorf("Insufficient free space for the index, temporary work and WAL above the PostgreSQL reserve.")
	}
	if b.ManagedBytes > ManagedIndexTotalBytes {
		return fmt.Errorf("UI index storage budget exceeded.")
	}
	return nil
}

func buildManagedIndex(ctx context.Context, db *gorm.DB, conn *indexSession, m models.ManagedDatabaseIndex) error {
	// Mark building before DDL, including when the preflight/cancellation fails:
	// recovery can always find and clean up this candidate.
	if err := db.WithContext(ctx).Model(&m).Updates(map[string]any{"status": "building", "message": "Building concurrently; CPE reads and writes remain available."}).Error; err != nil {
		return err
	}
	spec := IndexSpec{Label: m.Label, Purpose: m.Purpose, Recipe: m.Recipe, ParameterPath: m.ParameterPath}
	var buildErr error
	if m.CancelRequested {
		buildErr = fmt.Errorf("Index creation cancelled.")
	}
	if buildErr == nil {
		buildErr = ValidateIndexSpec(spec)
	}
	if buildErr == nil {
		buildErr = verifyActiveIndex(ctx, db, m)
	}
	overview, err := GetIndexOverview(ctx, db)
	if buildErr == nil {
		if err != nil {
			buildErr = err
		} else {
			buildErr = buildBudgetError(overview.Budget)
		}
	}
	schema, err := getIndexTargetSchema(ctx, db, spec)
	if buildErr == nil {
		buildErr = err
	}
	ddl, err := indexDDL(schema, m.CandidateName, spec)
	if buildErr == nil {
		buildErr = err
	}
	if buildErr == nil {
		// A pre-existing object is never silently replaced by CREATE IF NOT EXISTS.
		c, err := findCatalogIndex(ctx, db, m.CandidateName)
		if err != nil {
			buildErr = err
		} else if c != nil {
			buildErr = ErrIndexProtected
		}
	}
	if buildErr == nil {
		buildCtx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() { _, err := conn.ExecContext(buildCtx, ddl); done <- err }()
		ticker := time.NewTicker(2 * time.Second)
	loop:
		for {
			select {
			case buildErr = <-done:
				break loop
			case <-ctx.Done():
				cancel()
				<-done
				buildErr = ctx.Err()
				break loop
			case <-ticker.C:
				checkCtx, checkCancel := context.WithTimeout(ctx, 4*time.Second)
				state, err := GetIndexOverview(checkCtx, db)
				if err == nil {
					err = buildBudgetError(state.Budget)
				}
				if err == nil {
					for _, v := range state.Managed {
						if v.ID == m.ID && v.CancelRequested {
							err = fmt.Errorf("Index creation cancelled.")
						}
						if v.SizeBytes > ManagedIndexMaxBytes {
							err = fmt.Errorf("An existing UI index exceeded its storage limit; construction stopped to allow cleanup.")
						}
					}
				}
				if err == nil {
					for _, c := range state.Catalog {
						if c.Name == m.CandidateName && c.SizeBytes > ManagedIndexMaxBytes {
							err = fmt.Errorf("Index exceeded the 256 MiB size limit.")
						}
					}
				}
				checkCancel()
				if err != nil {
					cancel()
					<-done
					buildErr = err
					break loop
				}
			}
		}
		ticker.Stop()
		cancel()
	}
	// Cancelled pgx queries can close their connection; release the worker session
	// only after cleanup using a fresh, resource-limited session if necessary.
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cleanupCancel()
	cleanup, err := indexConnection(cleanupCtx, db)
	if err != nil {
		return err
	}
	defer closeIndexSession(cleanup)
	if _, err := cleanup.ExecContext(cleanupCtx, "SET lock_timeout='3s'"); err != nil {
		return err
	}
	if _, err := cleanup.ExecContext(cleanupCtx, "SET statement_timeout='20s'"); err != nil {
		return err
	}
	if buildErr != nil {
		if err := discardCandidate(cleanupCtx, db, cleanup, &m); err != nil {
			return indexFailure(cleanupCtx, db, m, fmt.Errorf("%v Cleanup pending: %w", buildErr, err))
		}
		return indexFailure(cleanupCtx, db, m, buildErr)
	}
	c, err := claimCandidate(cleanupCtx, db, cleanup, &m)
	if err == nil && (c == nil || !c.Valid || c.SizeBytes > ManagedIndexMaxBytes) {
		err = fmt.Errorf("New index is invalid or exceeds its size limit.")
	}
	if err == nil {
		state, stateErr := GetIndexOverview(cleanupCtx, db)
		if stateErr != nil {
			err = stateErr
		} else {
			err = buildBudgetError(state.Budget)
			for _, v := range state.Managed {
				if v.ID == m.ID && v.CancelRequested {
					err = fmt.Errorf("Index creation cancelled.")
				}
			}
		}
	}
	if err != nil {
		if cleanupErr := discardCandidate(cleanupCtx, db, cleanup, &m); cleanupErr != nil {
			return indexFailure(cleanupCtx, db, m, cleanupErr)
		}
		return indexFailure(cleanupCtx, db, m, err)
	}
	// Replacement is built and verified before removing the previous UI index.
	if err := dropActiveIndex(cleanupCtx, db, cleanup, &m); err != nil {
		return indexFailure(cleanupCtx, db, m, err)
	}
	return db.WithContext(cleanupCtx).Model(&m).Updates(map[string]any{
		"active_name": m.CandidateName, "active_oid": m.CandidateOID, "active_definition": m.CandidateDefinition, "active_token": m.CandidateToken,
		"candidate_name": "", "candidate_oid": 0, "candidate_definition": "", "candidate_token": "", "cancel_requested": false,
		"status": "ready", "message": "Index is available in PostgreSQL. Its use depends on the query planner and matching query predicates.",
	}).Error
}

func enforceManagedIndexBudgets(ctx context.Context, db *gorm.DB, conn *indexSession) error {
	state, err := GetIndexOverview(ctx, db)
	if err != nil {
		return err
	}
	for _, v := range state.Managed {
		// Clean up failed/invalid candidates too; never let abandoned builds grow.
		m := v.ManagedDatabaseIndex
		if m.CandidateName != "" && m.Status == "failed" {
			if err := discardCandidate(ctx, db, conn, &m); err != nil {
				if saveErr := indexFailure(ctx, db, m, err); saveErr != nil {
					return saveErr
				}
			}
		}
		if m.ActiveName == "" {
			continue
		}
		if !v.Owned {
			if saveErr := indexFailure(ctx, db, m, ErrIndexProtected); saveErr != nil {
				return saveErr
			}
			continue
		}
		reason := ""
		switch {
		case !v.Valid:
			reason = "An invalid UI index was removed from PostgreSQL."
		case v.SizeBytes > ManagedIndexMaxBytes:
			reason = "UI index removed after exceeding the 256 MiB limit."
		case state.Budget.ManagedBytes > ManagedIndexTotalBytes:
			reason = "UI index removed to restore the 1 GiB total storage budget."
		case state.Budget.ProbeFresh && state.Budget.FreeBytes < state.Budget.ReserveBytes:
			reason = "UI index removed to restore the PostgreSQL disk reserve."
		}
		if reason != "" {
			if err := dropActiveIndex(ctx, db, conn, &m); err != nil {
				return indexFailure(ctx, db, m, err)
			}
			log.Printf("DB index manager: definition %d: %s", m.ID, reason)
			return db.WithContext(ctx).Model(&m).Updates(map[string]any{"status": "evicted", "message": reason}).Error
		}
	}
	return nil
}
