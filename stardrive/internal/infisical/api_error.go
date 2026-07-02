package infisical

import (
	"fmt"
	"strings"
)

type APIError struct {
	ReqID      string `json:"reqId"`
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Err        string `json:"error"`
}

func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	switch {
	case strings.TrimSpace(e.Message) != "" && strings.TrimSpace(e.Err) != "":
		return fmt.Sprintf("infisical API %d: %s (%s)", e.StatusCode, e.Message, e.Err)
	case strings.TrimSpace(e.Message) != "":
		return fmt.Sprintf("infisical API %d: %s", e.StatusCode, e.Message)
	case strings.TrimSpace(e.Err) != "":
		return fmt.Sprintf("infisical API %d: %s", e.StatusCode, e.Err)
	default:
		return fmt.Sprintf("infisical API %d", e.StatusCode)
	}
}
