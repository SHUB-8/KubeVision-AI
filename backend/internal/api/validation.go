package api

import (
	"regexp"

	"k8s.io/apimachinery/pkg/util/validation"
)

var windowPattern = regexp.MustCompile(`^[1-9][0-9]*(ms|s|m|h|d|w|y)$`)

func validWindow(window string) bool {
	return len(window) <= 16 && windowPattern.MatchString(window)
}

func validNamespace(namespace string) bool {
	return namespace != "" && len(validation.IsDNS1123Label(namespace)) == 0
}

func validPodName(pod string) bool {
	return pod != "" && len(validation.IsDNS1123Subdomain(pod)) == 0
}
