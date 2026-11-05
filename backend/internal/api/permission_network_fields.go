package api

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/matrix8412/acs/internal/auth"
)

var networkParameterPath = regexp.MustCompile(`^InternetGatewayDevice\.(?:LANDevice\.[0-9]+\.(WLANConfiguration|LANEthernetInterfaceConfig)\.[0-9]+\.|WANDevice\.[0-9]+\.WANConnectionDevice\.[0-9]+\.(WANIPConnection|WANPPPConnection)\.[0-9]+\.)(.*)$`)

func networkParameterSection(name string) string {
	match := networkParameterPath.FindStringSubmatch(name)
	if match == nil {
		return ""
	}
	kind := "wan"
	if match[1] == "WLANConfiguration" {
		kind = "wifi"
	}
	if match[1] == "LANEthernetInterfaceConfig" {
		kind = "lan"
	}
	tab := networkFieldTabs[kind][match[3]]
	if tab == "" {
		tab = "advanced"
	}
	return "inventory.cpes.overview." + kind + "." + tab
}

func requireParameterEdits(w http.ResponseWriter, req *http.Request, parameters map[string]string) bool {
	if !auth.OperationAuthorized(req.Context()) || requestCan(req, "inventory.cpes.maintenance.diagnostic", "edit") {
		return true
	}
	for name := range parameters {
		section := networkParameterSection(name)
		if section == "" {
			section = "inventory.cpes.overview"
		}
		if !requestCan(req, section, "edit") {
			respondError(w, http.StatusForbidden, "Parameter edit permission required: "+section)
			return false
		}
	}
	return true
}

func readableNetworkParameter(req *http.Request, name string) bool {
	section := networkParameterSection(name)
	return section == "" || !auth.OperationAuthorized(req.Context()) || requestCan(req, section, "read")
}

func networkSections() []string {
	sections := []string{}
	for kind, tabs := range networkFieldTabs {
		seen := map[string]bool{}
		for _, tab := range tabs {
			if !seen[tab] {
				sections = append(sections, "inventory.cpes.overview."+kind+"."+tab)
				seen[tab] = true
			}
		}
	}
	return sections
}

func isOverviewConsumer(path string) bool {
	return path == "/devices" || path == "/provisioning/templates" || strings.HasSuffix(path, "/detail-parameters") || (strings.HasPrefix(path, "/device/") && strings.Count(path, "/") == 2)
}

// Keep aligned with the editable fields in the Wi-Fi, LAN and WAN dialogs.
var networkFieldTabs = map[string]map[string]string{
	"wifi": {
		"SSID":                         "general",
		"Enable":                       "general",
		"OperatingFrequencyBand":       "general",
		"Channel":                      "general",
		"ChannelWidth":                 "general",
		"MaxBitRate":                   "general",
		"X_HW_MaxBitRate":              "general",
		"Standard":                     "general",
		"BeaconType":                   "security",
		"WPAEncryptionModes":           "security",
		"PreSharedKey.1.KeyPassphrase": "security",
		"KeyPassphrase":                "security",
		"X_HW_WPAKey":                  "security",
		"KeyManagement":                "security",
		"TransmitPower":                "advanced",
		"X_HW_TransmitPower":           "advanced",
		"BeaconPeriod":                 "advanced",
		"DTIMPeriod":                   "advanced",
		"WMM":                          "advanced",
		"X_HW_WMM":                     "advanced",
		"BeaconTransmit":               "advanced",
		"MulticastSSID":                "advanced",
	},
	"lan": {
		"Name":                         "general",
		"Enable":                       "general",
		"X_HW_Speed":                   "general",
		"X_HW_DuplexMode":              "general",
		"X_HW_L3Enable":                "general",
		"X_HW_VLAN":                    "advanced",
		"VLANID":                       "advanced",
		"X_HW_PVID":                    "advanced",
		"X_HW_AutoNegotiation":         "advanced",
		"X_HW_FlowControl":             "advanced",
		"X_HW_EnergyEfficientEthernet": "advanced",
		"X_HW_PortMapping":             "advanced",
		"X_HW_LinkMode":                "advanced",
		"X_HW_802_1X":                  "advanced",
	},
	"wan": {
		"Name":                     "general",
		"Enable":                   "general",
		"ConnectionType":           "general",
		"AddressingType":           "general",
		"X_HW_LowerLayers":         "general",
		"X_HW_SERVICELIST":         "general",
		"X_HW_VLAN":                "general",
		"X_HW_PriPolicy":           "general",
		"X_HW_PRI":                 "general",
		"MaxMTUSize":               "general",
		"X_HW_MTU":                 "general",
		"Username":                 "general",
		"Password":                 "general",
		"X_HW_Passthrough":         "general",
		"PassthroughEnable":        "general",
		"X_HW_LCPDetection":        "general",
		"LCPDetection":             "general",
		"X_HW_LANBIND.Lan1Enable":  "general",
		"X_HW_LANBIND.Lan2Enable":  "general",
		"X_HW_LANBIND.Lan3Enable":  "general",
		"X_HW_LANBIND.Lan4Enable":  "general",
		"X_HW_LANBIND.SSID1Enable": "general",
		"X_HW_LANBIND.SSID2Enable": "general",
		"X_HW_LANBIND.SSID3Enable": "general",
		"X_HW_LANBIND.SSID4Enable": "general",
		"X_HW_LANBIND.SSID5Enable": "general",
		"X_HW_LANBIND.SSID6Enable": "general",
		"X_HW_LANBIND.SSID7Enable": "general",
		"X_HW_LANBIND.SSID8Enable": "general",
		"X_HW_IPv4AcqMode":         "ipv4",
		"IPv4AddressingType":       "ipv4",
		"NATEnabled":               "ipv4",
		"X_HW_NatType":             "ipv4",
		"X_HW_VenderClassID":       "ipv4",
		"X_HW_ClientID":            "ipv4",
		"X_HW_DialingMethod":       "ipv4",
		"DialingMethod":            "ipv4",
		"X_HW_MultiCastVLAN":       "ipv4",
		"X_HW_IPv6PrefixAcqMode":   "ipv6",
		"X_HW_PrefixAcqMode":       "ipv6",
		"X_HW_IPv6AcqMode":         "ipv6",
		"X_HW_IPv6AddressingMode":  "ipv6",
		"X_HW_IPv6PrefixMask":      "ipv6",
		"X_HW_PrefixMask":          "ipv6",
		"X_HW_IPv6MultiCastVLAN":   "ipv6",
		"X_HW_6RDTunnel.Mode":      "ipv6",
		"X_HW_DSLiteMode":          "ipv6",
		"X_HW_6RDTunnel.AFTRName":  "ipv6",
		"X_HW_AFTRName":            "ipv6",
		"X_HW_NPTv6Enable":         "ipv6",
		"ConnectionTrigger":        "advanced",
		"AutoDisconnectTime":       "advanced",
		"IdleDisconnectTime":       "advanced",
		"WarnDisconnectDelay":      "advanced",
		"ShapingRate":              "advanced",
		"ShapingBurstSize":         "advanced",
		"RouteProtocolRx":          "advanced",
	},
}
