package models

import "time"

// APIToken stores only a digest; the bearer credential is returned once at creation.
type APIToken struct {
	ID          int64      `json:"id" gorm:"primaryKey"`
	UserID      int64      `json:"user_id" gorm:"not null;index"`
	Name        string     `json:"name" gorm:"size:128;not null"`
	Description string     `json:"description" gorm:"size:512"`
	Prefix      string     `json:"prefix" gorm:"size:20;not null"`
	Digest      string     `json:"-" gorm:"size:64;not null;uniqueIndex"`
	CreatedAt   time.Time  `json:"created_at"`
	ExpiresAt   time.Time  `json:"expires_at" gorm:"not null"`
	LastUsedAt  *time.Time `json:"last_used_at"`
	RevokedAt   *time.Time `json:"revoked_at"`
}

func (APIToken) TableName() string { return "api_tokens" }
