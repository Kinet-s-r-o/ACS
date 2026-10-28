package api

import (
	"fmt"
	"strings"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
)

func prepareProvisioningVariableSecrets(variables, previous []models.ProvisioningVariable) error {
	previousByName := make(map[string]models.ProvisioningVariable, len(previous))
	for _, variable := range previous {
		previousByName[variable.Name] = variable
	}
	for variableIndex := range variables {
		variable := &variables[variableIndex]
		oldVariable := previousByName[variable.Name]
		for stepIndex := range variable.Steps {
			step := &variable.Steps[stepIndex]
			if step.Function != "hmac_sha256" || step.Args["key_source"] != "custom" {
				step.KeyConfigured = false
				continue
			}
			if step.Args == nil {
				step.Args = make(map[string]string)
			}
			secret := step.Args["key_secret"]
			if secret == "" && stepIndex < len(oldVariable.Steps) {
				oldStep := oldVariable.Steps[stepIndex]
				if oldStep.Function == "hmac_sha256" && oldStep.Args["key_source"] == "custom" {
					secret = oldStep.Args["key_secret"]
				}
			}
			if secret == "" {
				return fmt.Errorf("variable %s requires a custom HMAC secret of at least 16 characters", variable.Name)
			}
			if !strings.HasPrefix(secret, "enc:v1:") {
				if len(secret) < 16 {
					return fmt.Errorf("variable %s custom HMAC secret must contain at least 16 characters", variable.Name)
				}
				encrypted, err := database.EncryptValue(secret)
				if err != nil {
					return fmt.Errorf("could not protect custom HMAC secret for variable %s", variable.Name)
				}
				secret = encrypted
			}
			step.Args["key_secret"] = secret
			step.KeyConfigured = true
		}
	}
	return nil
}

func redactProvisioningVariableSecrets(variables []models.ProvisioningVariable) {
	for variableIndex := range variables {
		for stepIndex := range variables[variableIndex].Steps {
			step := &variables[variableIndex].Steps[stepIndex]
			if step.Function != "hmac_sha256" || step.Args["key_source"] != "custom" {
				continue
			}
			step.KeyConfigured = step.Args["key_secret"] != ""
			delete(step.Args, "key_secret")
		}
	}
}
