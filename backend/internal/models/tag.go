package models

import "time"

// TagDefinition is a centrally managed label that can be assigned to devices.
type TagDefinition struct {
	ID        string    `json:"id" gorm:"primaryKey;size:64"`
	Name      string    `json:"name" gorm:"size:64;not null"`
	Color     string    `json:"color" gorm:"size:7;not null"`
	CreatedAt time.Time `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt time.Time `json:"updated_at" gorm:"autoUpdateTime"`
}

func (TagDefinition) TableName() string { return "tag_definitions" }
