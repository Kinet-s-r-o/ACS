package database

import (
	"context"
	"errors"
	"time"

	"github.com/skydashnet/skyacs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrAPITokenLimit = errors.New("a user can have at most 100 active API tokens")

type APITokenRepository struct{ db *gorm.DB }

func NewAPITokenRepository(db *gorm.DB) *APITokenRepository { return &APITokenRepository{db: db} }

func (r *APITokenRepository) Create(ctx context.Context, token *models.APIToken) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var user models.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&user, token.UserID).Error; err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&models.APIToken{}).Where("user_id = ? AND revoked_at IS NULL AND expires_at > ?", token.UserID, time.Now()).Count(&count).Error; err != nil {
			return err
		}
		if count >= 100 {
			return ErrAPITokenLimit
		}
		return tx.Create(token).Error
	})
}

func (r *APITokenRepository) List(ctx context.Context, userID int64) ([]models.APIToken, error) {
	tokens := make([]models.APIToken, 0)
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).Order("created_at DESC, id DESC").Find(&tokens).Error
	return tokens, err
}

func (r *APITokenRepository) GetByDigest(ctx context.Context, digest string) (*models.APIToken, error) {
	var token models.APIToken
	err := r.db.WithContext(ctx).Where("digest = ?", digest).First(&token).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &token, err
}

func (r *APITokenRepository) Touch(ctx context.Context, id int64, now time.Time) error {
	return r.db.WithContext(ctx).Model(&models.APIToken{}).
		Where("id = ? AND (last_used_at IS NULL OR last_used_at < ?)", id, now.Add(-time.Minute)).Update("last_used_at", now).Error
}

func (r *APITokenRepository) Revoke(ctx context.Context, userID, id int64) error {
	result := r.db.WithContext(ctx).Model(&models.APIToken{}).Where("user_id = ? AND id = ?", userID, id).
		Update("revoked_at", gorm.Expr("COALESCE(revoked_at, ?)", time.Now().UTC()))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
