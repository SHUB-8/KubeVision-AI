package api

import (
	"context"
	"log/slog"
	"strings"

	"github.com/kubevision/backend/models"
)

// serviceLanguages resolves the runtime language for every service in the
// namespace from two independent telemetry sources.
//
// Prometheus target_info is the primary source: OBI exports one series per
// instrumented process carrying the language it detected in that process, so it
// is available as soon as a process has been seen — including services nobody
// has opened a trace for, and after a backend restart. Trace resource
// attributes are the fallback, and remain the authoritative answer for
// SDK-instrumented services that report their own language to Tempo without
// exporting target_info.
//
// Neither source is inferred from an image name, a container command line or a
// port number: when telemetry does not say, the field stays empty.
func (h *Handlers) serviceLanguages(ctx context.Context, namespace string) map[string]string {
	var fromMetrics map[string]string
	if h.promClient != nil {
		languages, err := h.promClient.GetServiceLanguages(namespace)
		if err != nil {
			slog.Warn("target_info language query failed", "namespace", namespace, "error", err)
		} else {
			fromMetrics = languages
		}
	}

	var fromTraces map[string]string
	if h.tempoClient != nil {
		fromTraces = h.tempoClient.ServiceLanguages()
	}

	return mergeServiceLanguages(fromMetrics, fromTraces)
}

// mergeServiceLanguages joins the metric-derived and trace-derived maps. The
// primary entry wins on conflict: a target_info value describes the process
// that owns the series, while a trace value is sampled from whichever span was
// last fetched.
func mergeServiceLanguages(primary, fallback map[string]string) map[string]string {
	if len(primary) == 0 && len(fallback) == 0 {
		return nil
	}
	merged := make(map[string]string, len(primary)+len(fallback))
	for service, language := range fallback {
		if language = normalizeLanguage(language); language != "" {
			merged[service] = language
		}
	}
	for service, language := range primary {
		if language = normalizeLanguage(language); language != "" {
			merged[service] = language
		}
	}
	return merged
}

func normalizeLanguage(language string) string {
	return strings.ToLower(strings.TrimSpace(language))
}

// attachNodeLanguages copies the language onto service nodes. External and
// cross-namespace nodes have no local process in this namespace, so they stay
// empty instead of inheriting a neighbour's language.
func attachNodeLanguages(topology *models.Topology, languages map[string]string) {
	if topology == nil || len(languages) == 0 {
		return
	}
	for i := range topology.Nodes {
		if topology.Nodes[i].Type != "service" {
			continue
		}
		if language := languages[topology.Nodes[i].ID]; language != "" {
			topology.Nodes[i].Language = language
		}
	}
}
