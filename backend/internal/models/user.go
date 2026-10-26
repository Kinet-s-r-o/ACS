package models

import "time"

type UserRole string

const (
	RoleFull UserRole = "full"
	RoleRead UserRole = "read"
)

type User struct {
	ID           int64      `json:"id" gorm:"primaryKey;autoIncrement"`
	Username     string     `json:"username" gorm:"uniqueIndex:idx_users_username;not null"`
	FirstName    string     `json:"first_name" gorm:"size:100;not null;default:''"`
	LastName     string     `json:"last_name" gorm:"size:100;not null;default:''"`
	Email        string     `json:"email" gorm:"size:254;not null;default:''"`
	PasswordHash string     `json:"-" gorm:"column:password_hash;not null"`
	Role         UserRole   `json:"role" gorm:"type:text;default:'read'"`
	RoleID       *int64     `json:"role_id" gorm:"index"`
	TokenVersion uint64     `json:"-" gorm:"not null;default:0"`
	CreatedAt    time.Time  `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt    time.Time  `json:"updated_at" gorm:"autoUpdateTime"`
	LastLogin    *time.Time `json:"last_login,omitempty"`
}

func (User) TableName() string {
	return "users"
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type LoginResponse struct {
	User        *User    `json:"user"`
	Permissions []string `json:"permissions"`
}

type CreateUserRequest struct {
	Username  string   `json:"username"`
	FirstName string   `json:"first_name"`
	LastName  string   `json:"last_name"`
	Email     string   `json:"email"`
	Password  string   `json:"password"`
	Role      UserRole `json:"role"`
	RoleID    *int64   `json:"role_id"`
}

type UpdateUserRequest struct {
	Username  string   `json:"username,omitempty"`
	FirstName *string  `json:"first_name,omitempty"`
	LastName  *string  `json:"last_name,omitempty"`
	Email     *string  `json:"email,omitempty"`
	Password  string   `json:"password,omitempty"`
	Role      UserRole `json:"role,omitempty"`
	RoleID    *int64   `json:"role_id"`
}
