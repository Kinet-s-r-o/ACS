package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matrix8412/acs/internal/database"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func TestMetaPublishesOnlySafeChartPreference(t *testing.T) {
	for _, tc := range []struct{ points, interval, wantInterval string }{
		{"false", "0", "0"}, {"true", "15", "15"}, {"", "3600", "3600"}, {"invalid", "-1", "30"}, {"true", "invalid", "30"}, {"", "", "30"},
	} {
		t.Run(tc.points+"/"+tc.interval, func(t *testing.T) {
			db, err := gorm.Open(postgres.Open("host=127.0.0.1 user=unused dbname=unused sslmode=disable"), &gorm.Config{DryRun: true, DisableAutomaticPing: true})
			if err != nil {
				t.Fatal(err)
			}
			// Intercept repository reads without connecting to PostgreSQL.
			allowed := map[string]bool{"app_name": true, "app_logo": true, "ui_datetime_format": true, "chart_show_points": true, "auto_refresh_interval": true}
			if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				where := tx.Statement.Clauses["WHERE"].Expression.(clause.Where)
				key := where.Exprs[0].(clause.Expr).Vars[0].(string)
				if !allowed[key] {
					t.Fatalf("public metadata accessed a private setting: %s", key)
				}
				setting := tx.Statement.Dest.(*database.Setting)
				setting.Key = key
				if key == "chart_show_points" {
					setting.Value = tc.points
				}
				if key == "auto_refresh_interval" {
					setting.Value = tc.interval
				}
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			r := &Router{settingsRepo: database.NewSettingsRepository(db)}
			w := httptest.NewRecorder()
			r.handleMeta(w, httptest.NewRequest("GET", "/meta", nil))
			var response map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			want := "true"
			if tc.points == "false" {
				want = "false"
			}
			if w.Code != http.StatusOK || response["chart_show_points"] != want || response["auto_refresh_interval"] != tc.wantInterval || len(response) != len(allowed) {
				t.Fatalf("unexpected public metadata: %d %+v", w.Code, response)
			}
		})
	}
}
