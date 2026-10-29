package models

import "time"

type UserDashboardPanel struct {
	ID        int64     `json:"id" gorm:"primaryKey;autoIncrement"`
	UserID    int64     `json:"user_id" gorm:"not null;uniqueIndex:idx_user_dashboard_panels_user_panel,priority:1;index"`
	PanelID   string    `json:"panel_id" gorm:"size:96;not null;uniqueIndex:idx_user_dashboard_panels_user_panel,priority:2"`
	Config    string    `json:"-" gorm:"type:text;not null"`
	CreatedAt time.Time `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt time.Time `json:"updated_at" gorm:"autoUpdateTime"`
	User      User      `json:"-" gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
}

func (UserDashboardPanel) TableName() string {
	return "user_dashboard_panels"
}
