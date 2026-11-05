package database

import (
	"context"
	"errors"
	"time"

	"github.com/matrix8412/acs/internal/authn"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

var (
	ErrLastFullAdmin  = errors.New("cannot demote or deactivate the last active full-access administrator")
	ErrLastLocalAdmin = errors.New("at least one active local full-access administrator must remain")
)

type UserRepository struct {
	db *gorm.DB
}

func NewUserRepository(db *gorm.DB) *UserRepository {
	return &UserRepository{db: db}
}

func (r *UserRepository) Create(ctx context.Context, user *models.User) error {
	return r.db.WithContext(ctx).Create(user).Error
}

func (r *UserRepository) GetByUsername(ctx context.Context, username string) (*models.User, error) {
	var user models.User
	err := r.db.WithContext(ctx).Where("username = ?", username).First(&user).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (r *UserRepository) GetByID(ctx context.Context, id int64) (*models.User, error) {
	var user models.User
	err := r.db.WithContext(ctx).First(&user, id).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (r *UserRepository) List(ctx context.Context) ([]*models.User, error) {
	var users []*models.User
	err := r.db.WithContext(ctx).Order("id").Find(&users).Error
	return users, err
}

func (r *UserRepository) UpdatePassword(ctx context.Context, id int64, passwordHash string) error {
	return r.db.WithContext(ctx).Model(&models.User{}).
		Where("id = ?", id).
		Updates(map[string]interface{}{
			"password_hash": passwordHash,
			"token_version": gorm.Expr("token_version + 1"),
		}).Error
}

func (r *UserRepository) Delete(ctx context.Context, id int64) error {
	return r.DeleteChecked(ctx, id, nil)
}

func (r *UserRepository) DeleteChecked(ctx context.Context, id int64, check func(*gorm.DB, *models.User) error) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("LOCK TABLE roles, users IN SHARE ROW EXCLUSIVE MODE").Error; err != nil {
			return err
		}
		var user models.User
		if err := tx.Select("id", "role", "role_id", "active", "auth_provider").First(&user, id).Error; err != nil {
			return err
		}
		if check != nil {
			if err := check(tx, &user); err != nil {
				return err
			}
		}
		if user.Active && user.Role == models.RoleFull {
			if authn.Normalize(user.AuthProvider) == "local" {
				if err := requireOtherLocalAdmin(tx, id); err != nil {
					return err
				}
			}
			var count int64
			if err := tx.Model(&models.User{}).Where("id <> ? AND role = ? AND active = ?", id, models.RoleFull, true).Count(&count).Error; err != nil {
				return err
			}
			if count == 0 {
				return ErrLastFullAdmin
			}
		}
		if err := tx.Where("user_id = ?", id).Delete(&models.APIToken{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&models.UserDashboardPanel{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&models.UserDashboardLayout{}).Error; err != nil {
			return err
		}
		return tx.Delete(&models.User{}, id).Error
	})
}

func (r *UserRepository) UpdateAccount(ctx context.Context, id int64, username, firstName, lastName, email string, required2FA, reset2FA bool, role models.UserRole, roleID *int64, passwordHash, authProvider string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE").Error; err != nil {
			return err
		}
		var current models.User
		if err := tx.First(&current, id).Error; err != nil {
			return err
		}
		if current.Active && current.Role == models.RoleFull && authn.Normalize(current.AuthProvider) == "local" && (role != models.RoleFull || authProvider != "local") {
			if err := requireOtherLocalAdmin(tx, id); err != nil {
				return err
			}
		}
		if current.Role == models.RoleFull && current.Active && role != models.RoleFull {
			var count int64
			if err := tx.Model(&models.User{}).Where("role = ? AND active = ?", models.RoleFull, true).Count(&count).Error; err != nil {
				return err
			}
			if count <= 1 {
				return ErrLastFullAdmin
			}
		}
		updates := map[string]interface{}{
			"auth_provider": authProvider,
			"username":      username,
			"first_name":    firstName,
			"last_name":     lastName,
			"email":         email,
			"required_2fa":  required2FA,
			"role":          role,
			"role_id":       roleID,
			"token_version": gorm.Expr("token_version + 1"),
		}
		if authProvider != "local" {
			updates["password_hash"] = ""
		} else if passwordHash != "" {
			updates["password_hash"] = passwordHash
		}
		if reset2FA {
			updates["two_factor_secret"] = ""
			updates["two_factor_pending_secret"] = ""
			updates["two_factor_last_step"] = -1
		}
		return tx.Model(&models.User{}).Where("id = ?", id).Updates(updates).Error
	})
}

func (r *UserRepository) SetTwoFactorPendingSecret(ctx context.Context, id int64, encryptedSecret string) error {
	return r.db.WithContext(ctx).Model(&models.User{}).Where("id = ?", id).
		Update("two_factor_pending_secret", encryptedSecret).Error
}

func (r *UserRepository) CompleteTwoFactorSetup(ctx context.Context, id int64, step int64) error {
	result := r.db.WithContext(ctx).Model(&models.User{}).Where("id = ? AND two_factor_pending_secret <> ''", id).
		Updates(map[string]interface{}{
			"two_factor_secret":         gorm.Expr("two_factor_pending_secret"),
			"two_factor_pending_secret": "",
			"two_factor_last_step":      step,
			"token_version":             gorm.Expr("token_version + 1"),
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (r *UserRepository) ConsumeTwoFactorStep(ctx context.Context, id, step int64) (bool, error) {
	result := r.db.WithContext(ctx).Model(&models.User{}).
		Where("id = ? AND two_factor_last_step < ?", id, step).
		Update("two_factor_last_step", step)
	return result.RowsAffected == 1, result.Error
}

func (r *UserRepository) SetActive(ctx context.Context, id int64, active bool) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE").Error; err != nil {
			return err
		}
		var user models.User
		if err := tx.First(&user, id).Error; err != nil {
			return err
		}
		if user.Active == active {
			return nil
		}
		if !active && user.Role == models.RoleFull && authn.Normalize(user.AuthProvider) == "local" {
			if err := requireOtherLocalAdmin(tx, id); err != nil {
				return err
			}
		}
		if !active && user.Role == models.RoleFull {
			var count int64
			if err := tx.Model(&models.User{}).Where("role = ? AND active = ?", models.RoleFull, true).Count(&count).Error; err != nil {
				return err
			}
			if count <= 1 {
				return ErrLastFullAdmin
			}
		}
		return tx.Model(&models.User{}).Where("id = ?", id).Updates(map[string]interface{}{
			"active":        active,
			"token_version": gorm.Expr("token_version + 1"),
		}).Error
	})
}

func requireOtherLocalAdmin(tx *gorm.DB, id int64) error {
	var count int64
	if err := tx.Model(&models.User{}).Where("id <> ? AND role = ? AND active = ? AND auth_provider = ?", id, models.RoleFull, true, "local").Count(&count).Error; err != nil {
		return err
	}
	if count == 0 {
		return ErrLastLocalAdmin
	}
	return nil
}

func (r *UserRepository) UpdateLastLogin(ctx context.Context, id int64) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&models.User{}).
		Where("id = ?", id).
		Update("last_login", &now).Error
}

func (r *UserRepository) Count(ctx context.Context) (int, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.User{}).Count(&count).Error
	return int(count), err
}

func (r *UserRepository) CountByRole(ctx context.Context, role models.UserRole) (int, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.User{}).Where("role = ?", role).Count(&count).Error
	return int(count), err
}
