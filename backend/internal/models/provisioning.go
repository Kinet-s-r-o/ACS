package models

import "time"

type ProvisioningTemplate struct {
	ID           int64                  `json:"id" gorm:"primaryKey;autoIncrement"`
	Name         string                 `json:"name" gorm:"not null;size:256"`
	Manufacturer string                 `json:"manufacturer" gorm:"size:128;default:''"`
	ProductClass string                 `json:"product_class" gorm:"size:128;default:''"`
	Description  string                 `json:"description,omitempty"`
	Variables    []ProvisioningVariable `json:"variables" gorm:"type:jsonb;serializer:json"`
	Features     []ProvisioningFeature  `json:"features" gorm:"type:jsonb;serializer:json"`
	ImagePath    string                 `json:"-" gorm:"size:512;default:''"`
	ImageType    string                 `json:"-" gorm:"size:64;default:''"`
	ImageURL     string                 `json:"image_url,omitempty" gorm:"-"`
	CreatedAt    time.Time              `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt    time.Time              `json:"updated_at" gorm:"autoUpdateTime"`
}

type ProvisioningFeature struct {
	ID          string                       `json:"id"`
	Name        string                       `json:"name"`
	Description string                       `json:"description,omitempty"`
	Controls    []ProvisioningFeatureControl `json:"controls"`
}

type ProvisioningFeatureControl struct {
	Key           string `json:"key"`
	Label         string `json:"label"`
	Type          string `json:"type"`
	Parameter     string `json:"parameter"`
	EnabledValue  string `json:"enabled_value,omitempty"`
	DisabledValue string `json:"disabled_value,omitempty"`
	Group         string `json:"group,omitempty"`
	Description   string `json:"description,omitempty"`
}

type ProvisioningVariable struct {
	Name   string                  `json:"name"`
	Source string                  `json:"source"`
	Value  string                  `json:"value,omitempty"`
	Steps  []ProvisioningTransform `json:"steps"`
}

type ProvisioningTransform struct {
	Function string            `json:"function"`
	Args     map[string]string `json:"args,omitempty"`
}

func (ProvisioningTemplate) TableName() string {
	return "provisioning_templates"
}

// SpecificityScore returns the template specificity: 2 = both manufacturer and
// product_class set, 1 = only one set, 0 = global (wildcard).
func (t *ProvisioningTemplate) SpecificityScore() int {
	score := 0
	if t.Manufacturer != "" {
		score++
	}
	if t.ProductClass != "" {
		score++
	}
	return score
}

type ProvisioningRule struct {
	ID             int64     `json:"id" gorm:"primaryKey;autoIncrement"`
	TemplateID     int64     `json:"template_id" gorm:"index"`
	ParameterName  string    `json:"parameter_name" gorm:"not null"`
	ParameterValue string    `json:"parameter_value"`
	ParameterType  string    `json:"parameter_type" gorm:"default:'string'"`
	Phase          string    `json:"phase" gorm:"size:16;default:'bootstrap'"`
	Tags           []string  `json:"tags,omitempty" gorm:"type:jsonb;serializer:json"`
	Enabled        bool      `json:"enabled" gorm:"default:true"`
	Version        uint64    `json:"version" gorm:"not null;default:1"`
	Description    string    `json:"description,omitempty"`
	AddObjectPath  string    `json:"add_object_path,omitempty" gorm:"size:512"`
	Order          int       `json:"order" gorm:"not null;default:0"`
	Condition      string    `json:"condition,omitempty" gorm:"size:1024;default:''"`
	CreatedAt      time.Time `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt      time.Time `json:"updated_at" gorm:"autoUpdateTime"`
}

func (ProvisioningRule) TableName() string {
	return "provisioning_rules"
}

type CreateProvisioningRuleRequest struct {
	TemplateID     int64    `json:"template_id"`
	ParameterName  string   `json:"parameter_name"`
	ParameterValue string   `json:"parameter_value"`
	ParameterType  string   `json:"parameter_type"`
	Phase          string   `json:"phase"`
	Tags           []string `json:"tags"`
	Enabled        bool     `json:"enabled"`
	Description    string   `json:"description"`
	AddObjectPath  string   `json:"add_object_path"`
	Order          int      `json:"order"`
	Condition      string   `json:"condition"`
}

type CreateProvisioningTemplateRequest struct {
	Name         string                 `json:"name"`
	Manufacturer string                 `json:"manufacturer"`
	ProductClass string                 `json:"product_class"`
	Description  string                 `json:"description"`
	Variables    []ProvisioningVariable `json:"variables"`
}

type ProvisioningApplication struct {
	ID          int64     `json:"id" gorm:"primaryKey;autoIncrement"`
	DeviceID    int64     `json:"device_id" gorm:"uniqueIndex:idx_provisioning_application_v2,priority:1;not null"`
	RuleID      int64     `json:"rule_id" gorm:"uniqueIndex:idx_provisioning_application_v2,priority:2;not null"`
	RuleVersion uint64    `json:"rule_version" gorm:"uniqueIndex:idx_provisioning_application_v2,priority:3;not null;default:1"`
	AppliedAt   time.Time `json:"applied_at" gorm:"autoCreateTime"`
}

func (ProvisioningApplication) TableName() string { return "provisioning_applications" }
