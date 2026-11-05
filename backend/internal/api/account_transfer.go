package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/authn"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

const maxAccountTransferSize = 5 << 20
const maxAccountImportRows = 10000

var errAccountImportForbidden = errors.New("Cannot grant permissions outside your own access")

// Transfers intentionally contain configuration only, with no authentication secrets.
type transferredUser struct {
	Username     string `json:"username"`
	AuthProvider string `json:"auth_provider"`
	FirstName    string `json:"first_name"`
	LastName     string `json:"last_name"`
	Email        string `json:"email"`
	Required2FA  bool   `json:"required_2fa" gorm:"column:required_2fa"`
	Active       bool   `json:"active"`
	RoleName     string `json:"role_name"`
}

type transferredRole struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
	IsSystem    bool     `json:"is_system"`
}

type accountTransfer struct {
	Format  string            `json:"format"`
	Version int               `json:"version"`
	Users   []transferredUser `json:"users,omitempty"`
	Roles   []transferredRole `json:"roles,omitempty"`
}

func decodeAccountTransfer(w http.ResponseWriter, req *http.Request, value any) error {
	req.Body = http.MaxBytesReader(w, req.Body, maxAccountTransferSize)
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return errors.New("Invalid JSON file or file exceeds 5 MB")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("The file must contain one JSON document")
	}
	return nil
}

func validateAccountTransfer(backup *accountTransfer, kind string) error {
	if backup.Version != 1 || backup.Format != "acs-"+kind {
		return fmt.Errorf("Select an ACS %s JSON export (version 1)", kind)
	}
	count := len(backup.Users)
	if kind == "roles" {
		count = len(backup.Roles)
	}
	if count < 1 || count > maxAccountImportRows || (kind == "users" && len(backup.Roles) > 0) || (kind == "roles" && len(backup.Users) > 0) {
		return fmt.Errorf("The file must contain 1 to %d %s and no other record type", maxAccountImportRows, kind)
	}
	return nil
}

func (r *Router) handleExportAccounts(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		var selection struct {
			IDs []int64 `json:"ids"`
		}
		if err := decodeAccountTransfer(w, req, &selection); err != nil || len(selection.IDs) == 0 || len(selection.IDs) > maxAccountImportRows {
			respondError(w, http.StatusBadRequest, "Select 1 to 10000 records to export")
			return
		}
		seen := map[int64]bool{}
		for _, id := range selection.IDs {
			if id <= 0 || seen[id] {
				respondError(w, http.StatusBadRequest, "Export IDs must be positive and unique")
				return
			}
			seen[id] = true
		}
		backup := accountTransfer{Format: "acs-" + kind, Version: 1}
		if kind == "users" {
			// Select only portable fields; password hashes and 2FA secrets never enter this query.
			var rows []struct {
				ID   int64
				User transferredUser `gorm:"embedded"`
			}
			err := r.db.WithContext(req.Context()).Table("users").
				Select("users.id, users.username, users.auth_provider, users.first_name, users.last_name, users.email, users.required_2fa, users.active, COALESCE(roles.name, CASE WHEN users.role = 'full' THEN 'admin' ELSE 'viewer' END) AS role_name").
				Joins("LEFT JOIN roles ON roles.id = users.role_id").Where("users.id IN ?", selection.IDs).Scan(&rows).Error
			if err != nil {
				respondError(w, http.StatusInternalServerError, "Could not export users")
				return
			}
			if len(rows) != len(selection.IDs) {
				respondError(w, http.StatusConflict, "The user list changed; refresh it before exporting")
				return
			}
			byID := map[int64]transferredUser{}
			for _, row := range rows {
				byID[row.ID] = row.User
			}
			for _, id := range selection.IDs {
				if row, ok := byID[id]; ok {
					backup.Users = append(backup.Users, row)
					delete(byID, id)
				}
			}
		} else {
			var rows []models.Role
			if err := r.db.WithContext(req.Context()).Where("id IN ?", selection.IDs).Find(&rows).Error; err != nil {
				respondError(w, http.StatusInternalServerError, "Could not export roles")
				return
			}
			if len(rows) != len(selection.IDs) {
				respondError(w, http.StatusConflict, "The role list changed; refresh it before exporting")
				return
			}
			byID := map[int64]transferredRole{}
			for _, row := range rows {
				byID[row.ID] = transferredRole{Name: row.Name, Description: row.Description, Permissions: row.Permissions, IsSystem: row.IsSystem}
			}
			for _, id := range selection.IDs {
				if row, ok := byID[id]; ok {
					backup.Roles = append(backup.Roles, row)
					delete(byID, id)
				}
			}
		}
		encoded, err := json.Marshal(backup)
		if err != nil || len(encoded) >= maxAccountTransferSize {
			respondError(w, http.StatusBadRequest, "Export exceeds 5 MB; narrow the filters and export smaller files")
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="acs-`+kind+`.json"`)
		respondJSON(w, http.StatusOK, backup)
	}
}

type accountImportError struct{ message string }

func (e accountImportError) Error() string { return e.message }

func (r *Router) handleImportAccounts(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		var backup accountTransfer
		if err := decodeAccountTransfer(w, req, &backup); err != nil {
			respondError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := validateAccountTransfer(&backup, kind); err != nil {
			respondError(w, http.StatusBadRequest, err.Error())
			return
		}
		validPermissions, err := r.validPermissionKeys(req.Context())
		if err != nil {
			respondError(w, http.StatusServiceUnavailable, "Permission catalog unavailable")
			return
		}
		created, skipped := 0, 0
		err = r.db.WithContext(req.Context()).Transaction(func(tx *gorm.DB) error {
			// Serialize against account/role edits so duplicate detection and grants stay consistent.
			if err := tx.Exec("LOCK TABLE roles, users IN SHARE ROW EXCLUSIVE MODE").Error; err != nil {
				return err
			}
			var existingRoles []models.Role
			if err := tx.Find(&existingRoles).Error; err != nil {
				return err
			}
			roleNames := map[string]models.Role{}
			for _, role := range existingRoles {
				roleNames[role.Name] = role
			}
			if kind == "roles" {
				for _, row := range backup.Roles {
					row.Name = strings.TrimSpace(row.Name)
					if row.Name == "" || len(row.Name) > 64 || len(row.Description) > 256 {
						return accountImportError{"Invalid role name or description"}
					}
					if _, exists := roleNames[row.Name]; exists {
						skipped++
						continue
					}
					if row.IsSystem || row.Name == "admin" || row.Name == "viewer" {
						return accountImportError{"System roles cannot be created by import"}
					}
					for _, permission := range row.Permissions {
						if !validPermissions[permission] {
							return accountImportError{"Unknown permission in role " + row.Name + ": " + permission}
						}
					}
					if !canGrantPermissions(req, row.Permissions) {
						return errAccountImportForbidden
					}
					role := models.Role{Name: row.Name, Description: row.Description, Permissions: row.Permissions}
					if role.Permissions == nil {
						role.Permissions = []string{}
					}
					if err := tx.Create(&role).Error; err != nil {
						return err
					}
					roleNames[row.Name] = role
					created++
				}
				return nil
			}
			var usernames []string
			if err := tx.Model(&models.User{}).Pluck("username", &usernames).Error; err != nil {
				return err
			}
			existing := map[string]bool{}
			for _, name := range usernames {
				existing[name] = true
			}
			for _, row := range backup.Users {
				row.Username = strings.TrimSpace(row.Username)
				row.AuthProvider = authn.Normalize(row.AuthProvider)
				if !validUsername(row.Username, row.AuthProvider) || !r.authenticationModules().Supports(row.AuthProvider) {
					return accountImportError{"Invalid username or authentication module"}
				}
				if existing[row.Username] {
					skipped++
					continue
				}
				row.FirstName, row.LastName, row.Email = strings.TrimSpace(row.FirstName), strings.TrimSpace(row.LastName), strings.TrimSpace(row.Email)
				if err := validateUserProfile(row.FirstName, row.LastName, row.Email); err != nil {
					return accountImportError{err.Error()}
				}
				role, ok := roleNames[row.RoleName]
				if !ok {
					return accountImportError{"Role not found: " + row.RoleName + ". Import roles first."}
				}
				permissions := role.Permissions
				if role.IsSystem && role.Name == "admin" {
					permissions = make([]string, 0, len(validPermissions))
					for key := range validPermissions {
						permissions = append(permissions, key)
					}
				}
				if !canGrantPermissions(req, permissions) {
					return errAccountImportForbidden
				}
				legacyRole := models.RoleRead
				if role.IsSystem && role.Name == "admin" {
					legacyRole = models.RoleFull
				}
				now := time.Now()
				// A map preserves explicit false despite the model's active=true creation default.
				if err := tx.Model(&models.User{}).Create(map[string]any{
					"username": row.Username, "auth_provider": row.AuthProvider, "first_name": row.FirstName,
					"last_name": row.LastName, "email": row.Email, "required_2fa": row.Required2FA,
					"active": false, "password_hash": "", "role": legacyRole, "role_id": role.ID,
					"created_at": now, "updated_at": now,
				}).Error; err != nil {
					return err
				}
				existing[row.Username] = true
				created++
			}
			return nil
		})
		if err != nil {
			var invalid accountImportError
			if errors.Is(err, errAccountImportForbidden) {
				respondError(w, http.StatusForbidden, errAccountImportForbidden.Error())
			} else if errors.As(err, &invalid) {
				respondError(w, http.StatusBadRequest, invalid.message)
			} else {
				respondError(w, http.StatusInternalServerError, "Import failed; no records were changed")
			}
			return
		}
		respondJSON(w, http.StatusOK, map[string]int{"created": created, "skipped": skipped})
	}
}
