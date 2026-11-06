package models

type CPEEditOption struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type CPEEditField struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Parameter string          `json:"parameter"`
	Type      string          `json:"type"`
	Input     string          `json:"input"`
	Span      int             `json:"span"`
	NewRow    bool            `json:"new_row"`
	Help      string          `json:"help"`
	Options   []CPEEditOption `json:"options"`
}

type CPEEditTab struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Columns int            `json:"columns"`
	Fields  []CPEEditField `json:"fields"`
}

type CPEEditWindow struct {
	Version     int          `json:"version"`
	Target      string       `json:"target"`
	Enabled     bool         `json:"enabled"`
	BasePattern string       `json:"base_pattern"`
	Tabs        []CPEEditTab `json:"tabs"`
}
