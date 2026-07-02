package operation

import (
	"encoding/json"
	"fmt"
	"time"
)

type Type string

const (
	TypeBootstrap         Type = "bootstrap"
	TypeDestroy           Type = "destroy"
	TypeScale             Type = "scale"
	TypeAddNode           Type = "add-node"
	TypeRemoveNode        Type = "remove-node"
	TypeUpgradeTalos      Type = "upgrade-talos"
	TypeUpgradeKubernetes Type = "upgrade-k8s"
	TypeBootstrapSecrets  Type = "bootstrap-secrets"
)

type PhaseStatus string

const (
	PhasePending    PhaseStatus = "pending"
	PhaseInProgress PhaseStatus = "in-progress"
	PhaseCompleted  PhaseStatus = "completed"
	PhaseFailed     PhaseStatus = "failed"
	PhaseSkipped    PhaseStatus = "skipped"
)

type Phase struct {
	Status      PhaseStatus     `json:"status"`
	StartedAt   *time.Time      `json:"startedAt,omitempty"`
	CompletedAt *time.Time      `json:"completedAt,omitempty"`
	Error       string          `json:"error,omitempty"`
	Data        json.RawMessage `json:"data,omitempty"`
}

type CleanupAction struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

type Operation struct {
	ID           string            `json:"id"`
	Type         Type              `json:"type"`
	Cluster      string            `json:"cluster"`
	CreatedAt    time.Time         `json:"createdAt"`
	UpdatedAt    time.Time         `json:"updatedAt"`
	CurrentPhase string            `json:"currentPhase"`
	PhaseOrder   []string          `json:"phaseOrder"`
	Phases       map[string]*Phase `json:"phases"`
	Context      map[string]any    `json:"context,omitempty"`
	Cleanup      []CleanupAction   `json:"cleanup,omitempty"`
}

func New(id string, opType Type, cluster string, phases []string) (*Operation, error) {
	if id == "" {
		return nil, fmt.Errorf("operation id is required")
	}
	if opType == "" {
		return nil, fmt.Errorf("operation type is required")
	}
	if cluster == "" {
		return nil, fmt.Errorf("cluster is required")
	}
	if len(phases) == 0 {
		return nil, fmt.Errorf("at least one phase is required")
	}

	now := time.Now().UTC()
	phaseMap := make(map[string]*Phase, len(phases))
	for _, phase := range phases {
		if phase == "" {
			return nil, fmt.Errorf("phase names must be non-empty")
		}
		if _, exists := phaseMap[phase]; exists {
			return nil, fmt.Errorf("duplicate phase name %q", phase)
		}
		phaseMap[phase] = &Phase{Status: PhasePending}
	}

	return &Operation{
		ID:           id,
		Type:         opType,
		Cluster:      cluster,
		CreatedAt:    now,
		UpdatedAt:    now,
		CurrentPhase: phases[0],
		PhaseOrder:   append([]string(nil), phases...),
		Phases:       phaseMap,
		Context:      map[string]any{},
	}, nil
}

func (o *Operation) ResumePhase() string {
	for _, name := range o.PhaseOrder {
		phase := o.Phases[name]
		if phase == nil {
			continue
		}
		if phase.Status != PhaseCompleted && phase.Status != PhaseSkipped {
			return name
		}
	}
	return ""
}

func (o *Operation) IsComplete() bool {
	return o.ResumePhase() == ""
}

func (o *Operation) StartPhase(name string) error {
	phase, ok := o.Phases[name]
	if !ok {
		return fmt.Errorf("unknown phase %q", name)
	}
	now := time.Now().UTC()
	phase.Status = PhaseInProgress
	phase.StartedAt = &now
	phase.Error = ""
	o.CurrentPhase = name
	o.UpdatedAt = now
	return nil
}

func (o *Operation) CompletePhase(name string, data any) error {
	phase, ok := o.Phases[name]
	if !ok {
		return fmt.Errorf("unknown phase %q", name)
	}
	now := time.Now().UTC()
	phase.Status = PhaseCompleted
	phase.CompletedAt = &now
	phase.Error = ""
	o.UpdatedAt = now
	if data != nil {
		encoded, err := json.Marshal(data)
		if err != nil {
			return fmt.Errorf("encode phase data: %w", err)
		}
		phase.Data = encoded
	}
	o.CurrentPhase = o.ResumePhase()
	return nil
}

func (o *Operation) SkipPhase(name string, reason string) error {
	phase, ok := o.Phases[name]
	if !ok {
		return fmt.Errorf("unknown phase %q", name)
	}
	now := time.Now().UTC()
	phase.Status = PhaseSkipped
	phase.CompletedAt = &now
	phase.Error = reason
	o.UpdatedAt = now
	o.CurrentPhase = o.ResumePhase()
	return nil
}

func (o *Operation) FailPhase(name string, err error) error {
	phase, ok := o.Phases[name]
	if !ok {
		return fmt.Errorf("unknown phase %q", name)
	}
	now := time.Now().UTC()
	phase.Status = PhaseFailed
	if err != nil {
		phase.Error = err.Error()
	}
	o.UpdatedAt = now
	o.CurrentPhase = name
	return nil
}

func (o *Operation) SetContext(key string, value any) {
	if o.Context == nil {
		o.Context = map[string]any{}
	}
	o.Context[key] = value
	o.UpdatedAt = time.Now().UTC()
}

func (o *Operation) AddCleanup(actionType string, data any) error {
	encoded, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("encode cleanup data: %w", err)
	}
	o.Cleanup = append(o.Cleanup, CleanupAction{Type: actionType, Data: encoded})
	o.UpdatedAt = time.Now().UTC()
	return nil
}
