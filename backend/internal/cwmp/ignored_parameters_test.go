package cwmp

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestIgnoredBranchesFullRefresh(t *testing.T) {
	for _, root := range []string{"Device.", "InternetGatewayDevice."} {
		t.Run(root, func(t *testing.T) {
			h, faults := diagnostic9005TestHandler(t, nil)
			s := h.sessions.GetOrCreate("ignored-full", "TEST")
			s.DataModelRoot, s.AutoFetchReady = root, true
			s.IgnoredParameterBranches = []string{root + "LANDevice.*.WLANConfiguration.*.STAWMMParameter."}
			request, _, err := h.handleEmptyPost(context.Background(), s.ID)
			gpn, ok := request.(*GetParameterNames)
			if err != nil || !ok || gpn.ParameterPath != root || gpn.NextLevel {
				t.Fatalf("initial request=%#v err=%v", request, err)
			}
			allowed := root + "DeviceInfo.UpTime"
			sibling := root + "LANDevice.1.WLANConfiguration.4.STAWMMParameterExtra.Value"
			ignored := root + "LANDevice.1.WLANConfiguration.4.STAWMMParameter.4.TXOP"
			request, err = h.handleGetParameterNamesResponse(context.Background(), &GetParameterNamesResp{ParameterList: []ParameterInfoStruct{{Name: ignored}, {Name: allowed}, {Name: sibling}}}, s.ID)
			gpv, ok := request.(*GetParameterValues)
			if err != nil || !ok || !slices.Equal(gpv.ParameterNames, []string{allowed, sibling}) {
				t.Fatalf("filtered read=%#v err=%v", request, err)
			}
			request, err = h.handleGetParameterValuesResponse(context.Background(), &GetParameterValuesResp{ParameterList: ParameterList{Parameters: []ParameterValueStruct{{Name: allowed, Value: "1"}, {Name: sibling, Value: "2"}}}}, s.ID)
			if _, ok := request.(*GetParameterNames); err != nil || !ok || s.FullTreeRead != nil || s.AutoFetchPhase != 2 || len(*faults) != 0 {
				t.Fatalf("completion=%#v err=%v", request, err)
			}
		})
	}
}

func TestIgnoredDynamicBranchesNeverDispatchEmptyGPV(t *testing.T) {
	for _, overview := range []bool{false, true} {
		h, faults := diagnostic9005TestHandler(t, nil)
		s := h.sessions.GetOrCreate("ignored-dynamic", "TEST")
		s.DataModelRoot, s.OverviewFetchReady = "Device.", true
		s.DynamicParameterBranches = []string{"Device.WiFi."}
		s.IgnoredParameterBranches = []string{"Device.WiFi."}
		s.OverviewFetchParams = []string{"Device.WiFi.SSID.1.Name"}
		if overview {
			s.OverviewFetchParams = append(s.OverviewFetchParams, "Device.DeviceInfo.UpTime")
		}
		request, _, err := h.handleEmptyPost(context.Background(), s.ID)
		if err != nil || len(*faults) != 0 {
			t.Fatalf("err=%v faults=%v", err, *faults)
		}
		if overview {
			gpv, ok := request.(*GetParameterValues)
			if !ok || !slices.Equal(gpv.ParameterNames, []string{"Device.DeviceInfo.UpTime"}) {
				t.Fatalf("request=%#v", request)
			}
		} else if request != nil || s.OverviewFetchActive || s.DynamicDiscoveryActive {
			t.Fatalf("empty discovery=%#v", request)
		}
	}
}

func TestIgnoredAllFullTreeLeavesDoesNotSendEmptyGPV(t *testing.T) {
	h, _ := diagnostic9005TestHandler(t, nil)
	s := h.sessions.GetOrCreate("ignored-empty", "TEST")
	s.State, s.AutoFetchPhase, s.DataModelRoot = StateProcessingTasks, 1, "Device."
	s.IgnoredParameterBranches = []string{"Device.WiFi."}
	startFullTreeRefresh(s, s.DataModelRoot)
	request, err := h.handleGetParameterNamesResponse(context.Background(), &GetParameterNamesResp{ParameterList: []ParameterInfoStruct{{Name: "Device.WiFi.Enable"}}}, s.ID)
	if _, ok := request.(*GetParameterValues); ok || err != nil || s.FullTreeRead != nil {
		t.Fatalf("empty read=%#v err=%v", request, err)
	}
}

func TestQueuedFullTreeRefreshUsesIgnoredBranches(t *testing.T) {
	db, err := gorm.Open(postgres.New(postgres.Config{Conn: snapshotInformConnection{}}), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal([]string{"InternetGatewayDevice."})
	if err := db.Callback().Query().After("gorm:query").Register("test:queued-full-tree", func(tx *gorm.DB) {
		if task, ok := tx.Statement.Dest.(*models.Task); ok {
			*task = models.Task{ID: 42, DeviceID: 1, Type: models.TaskTypeGetParameterValues, Status: models.TaskStatusPending, Payload: payload}
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Update().After("gorm:update").Register("test:claim-queued-full-tree", func(tx *gorm.DB) { tx.RowsAffected = 1 }); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(nil)
	h.taskRepo = database.NewTaskRepository(db)
	s := h.sessions.GetOrCreate("queued-ignored", "TEST")
	s.DeviceID, s.DataModelRoot = 1, "InternetGatewayDevice."
	s.IgnoredParameterBranches = []string{"InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.STAWMMParameter."}
	request, _, err := h.handleEmptyPost(context.Background(), s.ID)
	gpn, ok := request.(*GetParameterNames)
	if err != nil || !ok || gpn.ParameterPath != s.DataModelRoot || gpn.NextLevel || s.CurrentTaskID != 42 || !s.CurrentFullTreeFetch || s.FullTreeRead == nil {
		t.Fatalf("queued refresh=%#v err=%v", request, err)
	}
}
