package database

import (
	"context"
	"errors"
	"fmt"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

var (
	ErrRoleNotFound  = errors.New("role not found")
	ErrRoleInUse     = errors.New("role is assigned to one or more users")
	ErrSystemRole    = errors.New("cannot modify system role")
	ErrDuplicateRole = errors.New("role name already exists")
)

type RoleRepository struct {
	db *gorm.DB
}

func NewRoleRepository(db *gorm.DB) *RoleRepository {
	return &RoleRepository{db: db}
}

func (r *RoleRepository) Create(ctx context.Context, role *models.Role) error {
	result := r.db.WithContext(ctx).Create(role)
	if result.Error != nil {
		if isDuplicateError(result.Error) {
			return ErrDuplicateRole
		}
		return result.Error
	}
	return nil
}

func (r *RoleRepository) GetByID(ctx context.Context, id int64) (*models.Role, error) {
	var role models.Role
	if err := r.db.WithContext(ctx).First(&role, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrRoleNotFound
		}
		return nil, err
	}
	return &role, nil
}

func (r *RoleRepository) GetByName(ctx context.Context, name string) (*models.Role, error) {
	var role models.Role
	if err := r.db.WithContext(ctx).Where("name = ?", name).First(&role).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrRoleNotFound
		}
		return nil, err
	}
	return &role, nil
}

func (r *RoleRepository) List(ctx context.Context) ([]models.Role, error) {
	var roles []models.Role
	if err := r.db.WithContext(ctx).Order("name ASC").Find(&roles).Error; err != nil {
		return nil, err
	}
	return roles, nil
}

func (r *RoleRepository) Update(ctx context.Context, role *models.Role) error {
	result := r.db.WithContext(ctx).Save(role)
	if result.Error != nil {
		if isDuplicateError(result.Error) {
			return ErrDuplicateRole
		}
		return result.Error
	}
	return nil
}

func (r *RoleRepository) Delete(ctx context.Context, id int64) error {
	var role models.Role
	if err := r.db.WithContext(ctx).First(&role, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrRoleNotFound
		}
		return err
	}
	if role.IsSystem {
		return ErrSystemRole
	}
	var count int64
	if err := r.db.WithContext(ctx).Model(&models.User{}).Where("role_id = ?", id).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrRoleInUse
	}
	return r.db.WithContext(ctx).Delete(&role).Error
}

// GetPermissions returns the permission keys for a given role ID.
// Returns nil if the role is not found (caller should handle fallback).
func (r *RoleRepository) GetPermissions(ctx context.Context, roleID int64) ([]string, error) {
	if roleID == 0 {
		return nil, nil
	}
	var role models.Role
	if err := r.db.WithContext(ctx).First(&role, roleID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return role.Permissions, nil
}

func isDuplicateError(err error) bool {
	return err != nil && (containsSubstring(err.Error(), "duplicate") || containsSubstring(err.Error(), "unique"))
}

func containsSubstring(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && indexOf(s, substr) >= 0)
}

func indexOf(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

var _ = fmt.Sprintf // keep fmt import if unused in future
