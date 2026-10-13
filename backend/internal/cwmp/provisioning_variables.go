package cwmp

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	"github.com/skydashnet/skyacs/internal/models"
)

var variableTokenPattern = regexp.MustCompile(`\{\{([A-Za-z][A-Za-z0-9_]*)\}\}`)

func resolveProvisioningVariables(definitions []models.ProvisioningVariable, device DeviceId, parameters map[string]string) (map[string]string, error) {
	values := make(map[string]string, len(definitions))
	for _, definition := range definitions {
		value := definition.Value
		switch definition.Source {
		case "":
			value = ""
		case "literal":
		case "serial_number":
			value = device.SerialNumber
		case "manufacturer":
			value = device.Manufacturer
		case "product_class":
			value = device.ProductClass
		case "oui":
			value = device.OUI
		case "parameter":
			value = parameters[value]
		default:
			return nil, fmt.Errorf("variable %s has unsupported source %q", definition.Name, definition.Source)
		}
		var err error
		value, err = expandVariableTokens(value, values)
		if err != nil {
			return nil, fmt.Errorf("variable %s: %w", definition.Name, err)
		}
		for _, step := range definition.Steps {
			for key, arg := range step.Args {
				step.Args[key], err = expandVariableTokens(arg, values)
				if err != nil {
					return nil, fmt.Errorf("variable %s argument %s: %w", definition.Name, key, err)
				}
			}
			value, err = applyProvisioningTransform(value, step)
			if err != nil {
				return nil, fmt.Errorf("variable %s transformation %s: %w", definition.Name, step.Function, err)
			}
			if len(value) > 8192 {
				return nil, fmt.Errorf("variable %s exceeds 8192 characters", definition.Name)
			}
		}
		values[definition.Name] = value
	}
	return values, nil
}

func expandVariableTokens(value string, variables map[string]string) (string, error) {
	var missing string
	result := variableTokenPattern.ReplaceAllStringFunc(value, func(token string) string {
		name := variableTokenPattern.FindStringSubmatch(token)[1]
		resolved, ok := variables[name]
		if !ok {
			missing = name
			return token
		}
		return resolved
	})
	if missing != "" {
		return "", fmt.Errorf("unknown or forward variable reference %q", missing)
	}
	return result, nil
}

func applyProvisioningTransform(value string, step models.ProvisioningTransform) (string, error) {
	arg := func(key, fallback string) string {
		if step.Args == nil || step.Args[key] == "" {
			return fallback
		}
		return step.Args[key]
	}
	toInt := func(key string, fallback int) (int, error) {
		if arg(key, "") == "" {
			return fallback, nil
		}
		return strconv.Atoi(arg(key, ""))
	}
	switch step.Function {
	case "trim":
		return strings.TrimSpace(value), nil
	case "upper":
		return strings.ToUpper(value), nil
	case "lower":
		return strings.ToLower(value), nil
	case "prefix":
		return arg("text", "") + value, nil
	case "suffix":
		return value + arg("text", ""), nil
	case "slice":
		start, err := toInt("start", 0)
		if err != nil {
			return "", fmt.Errorf("invalid start index")
		}
		runes := []rune(value)
		length := len(runes)
		end := length
		if rawEnd := arg("end", ""); rawEnd != "" {
			end, err = strconv.Atoi(rawEnd)
			if err != nil {
				return "", fmt.Errorf("invalid end index")
			}
		}
		if start < 0 {
			start += length
		}
		if end < 0 {
			end += length
		}
		if start < 0 {
			start = 0
		}
		if start > length {
			start = length
		}
		if end < 0 {
			end = 0
		}
		if end > length {
			end = length
		}
		if end < start {
			end = start
		}
		return string(runes[start:end]), nil
	case "replace":
		old := arg("search", "")
		if old == "" {
			return "", fmt.Errorf("search text is required")
		}
		return strings.ReplaceAll(value, old, arg("replace", "")), nil
	case "regex_replace":
		pattern, err := regexp.Compile(arg("pattern", ""))
		if err != nil {
			return "", err
		}
		return pattern.ReplaceAllString(value, arg("replace", "")), nil
	case "pad_start", "pad_end":
		target, err := toInt("length", 0)
		if err != nil || target < 0 || target > 4096 {
			return "", fmt.Errorf("length must be between 0 and 4096")
		}
		pad := []rune(arg("text", " "))
		if len(pad) == 0 {
			return "", fmt.Errorf("padding text cannot be empty")
		}
		runes := []rune(value)
		if len(runes) >= target {
			return value, nil
		}
		padding := make([]rune, target-len(runes))
		for index := range padding {
			padding[index] = pad[index%len(pad)]
		}
		if step.Function == "pad_start" {
			return string(padding) + value, nil
		}
		return value + string(padding), nil
	case "default":
		if value == "" {
			return arg("value", ""), nil
		}
		return value, nil
	case "random_string":
		length, err := toInt("length", 0)
		if err != nil || length < 1 || length > 256 {
			return "", fmt.Errorf("length must be between 1 and 256")
		}
		charsets := map[string]string{"alphanumeric": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "digits": "0123456789", "lowercase": "abcdefghijklmnopqrstuvwxyz", "uppercase": "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "hex": "0123456789abcdef"}
		charset := charsets[arg("charset", "")]
		if charset == "" {
			return "", fmt.Errorf("unsupported character set")
		}
		var output strings.Builder
		for range length {
			index, err := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
			if err != nil {
				return "", err
			}
			output.WriteByte(charset[index.Int64()])
		}
		return output.String(), nil
	case "sha256":
		digest := sha256.Sum256([]byte(value))
		return hex.EncodeToString(digest[:]), nil
	case "base64_encode":
		return base64.StdEncoding.EncodeToString([]byte(value)), nil
	case "base64_decode":
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return "", err
		}
		return string(decoded), nil
	case "hex_encode":
		return hex.EncodeToString([]byte(value)), nil
	case "hex_decode":
		decoded, err := hex.DecodeString(value)
		if err != nil {
			return "", err
		}
		return string(decoded), nil
	default:
		return "", fmt.Errorf("unsupported transformation %q", step.Function)
	}
}

func expandProvisioningValue(value string, variables map[string]string) (string, error) {
	return expandVariableTokens(value, variables)
}
