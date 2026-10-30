package models

import "time"

type UserDashboardLayout struct {
	UserID    int64     `json:"user_id" gorm:"primaryKey;not null"`
	Config    string    `json:"-" gorm:"type:text;not null"`
	UpdatedAt time.Time `json:"updated_at" gorm:"autoUpdateTime"`
	User      User      `json:"-" gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
}

func (UserDashboardLayout) TableName() string {
	return "user_dashboard_layouts"
}
