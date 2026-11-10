package database

import (
	"context"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/callbacks"
	"gorm.io/gorm/logger"
)

type inventorySQLLog struct {
	logger.Interface
	queries []string
}

func (l *inventorySQLLog) Trace(_ context.Context, _ time.Time, sql func() (string, int64), _ error) {
	query, _ := sql()
	l.queries = append(l.queries, query)
}

// Guard the inventory request against reintroducing parameter-tree scans when
// displaying, sorting, or filtering WAN counts on a large fleet.
func TestInventoryWANCountUsesSummary(t *testing.T) {
	for _, scenario := range []struct {
		name, sort, filters string
	}{
		{name: "default page"},
		{name: "sorted page", sort: "wan_interfaces_count"},
		{name: "numeric filter", filters: `{"wan_interfaces_count":{"logic":"all","rules":[{"operator":"greater_than","value":"2"}]}}`},
		{name: "snapshot sort", sort: "snapshot_count"},
		{name: "snapshot numeric filter", filters: `{"snapshot_count":{"logic":"all","rules":[{"operator":"greater_than","value":"0"}]}}`},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			log := &inventorySQLLog{Interface: logger.Default}
			db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test sslmode=disable"), &gorm.Config{
				DisableAutomaticPing: true, SkipDefaultTransaction: true, Logger: log,
			})
			if err != nil {
				t.Fatal(err)
			}
			// Build both statements without executing them. Unlike DryRun, this
			// resets GORM's SQL buffer between the total and page queries.
			if err := db.Callback().Query().Replace("gorm:query", callbacks.BuildQuerySQL); err != nil {
				t.Fatal(err)
			}
			filters, err := ParseDeviceInventoryFilters(scenario.filters)
			if err != nil {
				t.Fatal(err)
			}
			_, _, err = NewDeviceRepository(db).ListInventory(context.Background(), DeviceInventoryQuery{
				Limit: 20, Offset: 40, Sort: scenario.sort, Direction: "desc", Filters: filters,
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(log.queries) != 2 {
				t.Fatalf("expected total and page queries, got %d", len(log.queries))
			}
			for _, query := range log.queries {
				if strings.Contains(query, "device_parameters") || strings.Contains(query, "regexp_replace") {
					t.Fatalf("WAN inventory query scans the parameter tree: %s", query)
				}
			}
			page := log.queries[1]
			if !strings.Contains(page, inventorySnapshotCountExpression+" AS snapshot_count") {
				t.Fatalf("missing per-device snapshot count: %s", page)
			}
			if !strings.Contains(page, "FROM wan_interfaces WHERE wan_interfaces.device_id = devices.id") || !strings.Contains(page, "AS wan_interfaces_count") || !strings.Contains(page, "LIMIT 20 OFFSET 40") {
				t.Fatalf("missing indexed WAN count or pagination: %s", page)
			}
			countExpression := inventoryWANInterfacesCountExpression
			if strings.Contains(scenario.filters, "snapshot_count") {
				countExpression = inventorySnapshotCountExpression
			}
			if scenario.filters != "" && !strings.Contains(log.queries[0], countExpression) {
				t.Fatalf("filtered total does not use per-device count: %s", log.queries[0])
			}
		})
	}
}
