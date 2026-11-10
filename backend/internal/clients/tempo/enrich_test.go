package tempo

import (
	"testing"

	"github.com/kubevision/backend/models"
)

const testBase = int64(1_000_000_000)

func clientSpan(service, method, address, port string, start int64) models.Span {
	return models.Span{
		TraceID: "trace-1", SpanID: "client-" + service, Kind: "client",
		ServiceName: service, StartTime: start, Duration: 5_000_000,
		OperationName: method,
		Attributes: map[string]string{
			"rpc.method":      method,
			"rpc.system.name": "grpc",
			"server.address":  address,
			"server.port":     port,
		},
	}
}

func genericServerSpan(service, address, port string, start int64) models.Span {
	return models.Span{
		TraceID: "trace-1", SpanID: "server-" + service, Kind: "server",
		ServiceName: service, StartTime: start, Duration: 3_000_000,
		OperationName: "grpc",
		Attributes: map[string]string{
			"rpc.method":      "_OTHER",
			"rpc.system.name": "grpc",
			"server.address":  address,
			"server.port":     port,
		},
	}
}

func genericClientSpan(service, address, port string, start int64) models.Span {
	return models.Span{
		TraceID: "trace-1", SpanID: "gclient-" + service, Kind: "client",
		ServiceName: service, StartTime: start, Duration: 5_000_000,
		OperationName: "grpc",
		Attributes: map[string]string{
			"rpc.method":      "_OTHER",
			"rpc.system.name": "grpc",
			"server.address":  address,
			"server.port":     port,
		},
	}
}

func concreteServerSpan(service, method, port string, start int64) models.Span {
	return models.Span{
		TraceID: "trace-1", SpanID: "server-" + service, Kind: "server",
		ServiceName: service, StartTime: start, Duration: 3_000_000,
		OperationName: method,
		Attributes: map[string]string{
			"rpc.method":      method,
			"rpc.system.name": "grpc",
			"server.port":     port,
		},
	}
}

func TestEnrichGenericServerFromConcreteClient(t *testing.T) {
	spans := []models.Span{
		clientSpan("frontend", "hipstershop.CurrencyService/Convert", "currencyservice", "7000", testBase),
		genericServerSpan("currencyservice", "currencyservice", "7000", testBase+1_000_000),
	}
	enrichGenericRPCNames(spans)

	if got := spans[1].OperationName; got != "hipstershop.CurrencyService/Convert" {
		t.Fatalf("operation name = %q, want the recovered method", got)
	}
	if !spans[1].RPCNameInferred {
		t.Fatal("RPCNameInferred not set on the recovered span")
	}
	if got := spans[1].Attributes["rpc.method"]; got != "hipstershop.CurrencyService/Convert" {
		t.Fatalf("rpc.method = %q, want the recovered method", got)
	}
	if spans[0].RPCNameInferred || spans[0].OperationName != "hipstershop.CurrencyService/Convert" {
		t.Fatal("the observed client span must not be marked or modified")
	}
}

func TestEnrichGenericClientFromConcreteServer(t *testing.T) {
	spans := []models.Span{
		genericClientSpan("recommendationservice", "productcatalogservice", "3550", testBase),
		concreteServerSpan("productcatalogservice", "hipstershop.ProductCatalogService/ListProducts", "3550", testBase+800_000),
	}
	enrichGenericRPCNames(spans)

	if got := spans[0].OperationName; got != "hipstershop.ProductCatalogService/ListProducts" {
		t.Fatalf("operation name = %q, want the recovered method", got)
	}
	if !spans[0].RPCNameInferred {
		t.Fatal("RPCNameInferred not set on the recovered client span")
	}
	if spans[1].RPCNameInferred {
		t.Fatal("the observed server span must not be marked")
	}
}

func TestEnrichPortFallbackWhenAddressIsIP(t *testing.T) {
	spans := []models.Span{
		clientSpan("frontend", "hipstershop.CurrencyService/GetSupportedCurrencies", "10.43.184.237", "7000", testBase),
		genericServerSpan("currencyservice", "currencyservice", "7000", testBase+1_000_000),
	}
	enrichGenericRPCNames(spans)

	if !spans[1].RPCNameInferred {
		t.Fatal("expected a port-based match when the client recorded a pod IP")
	}
}

func TestEnrichDoesNotMatchWrongTarget(t *testing.T) {
	spans := []models.Span{
		clientSpan("frontend", "hipstershop.AdService/GetAds", "adservice", "9555", testBase),
		genericServerSpan("currencyservice", "currencyservice", "7000", testBase+1_000_000),
	}
	enrichGenericRPCNames(spans)
	if spans[1].RPCNameInferred {
		t.Fatal("must not pair spans that target different services/ports")
	}
}

func TestEnrichDoesNotMatchOutsideTimeWindow(t *testing.T) {
	spans := []models.Span{
		clientSpan("frontend", "hipstershop.CurrencyService/Convert", "currencyservice", "7000", testBase),
		genericServerSpan("currencyservice", "currencyservice", "7000", testBase+50_000_000),
	}
	enrichGenericRPCNames(spans)
	if spans[1].RPCNameInferred {
		t.Fatal("must not pair spans whose windows do not overlap")
	}
}

func TestEnrichLeavesConcreteSpansAlone(t *testing.T) {
	spans := []models.Span{
		clientSpan("frontend", "hipstershop.CurrencyService/Convert", "currencyservice", "7000", testBase),
		concreteServerSpan("currencyservice", "hipstershop.CurrencyService/Convert", "7000", testBase+1_000_000),
	}
	before := spans[0].OperationName
	enrichGenericRPCNames(spans)
	if spans[0].OperationName != before || spans[0].RPCNameInferred || spans[1].RPCNameInferred {
		t.Fatal("concrete spans must not be modified")
	}
}

func TestEnrichIsIdempotent(t *testing.T) {
	spans := []models.Span{
		clientSpan("frontend", "hipstershop.CurrencyService/Convert", "currencyservice", "7000", testBase),
		genericServerSpan("currencyservice", "currencyservice", "7000", testBase+1_000_000),
	}
	enrichGenericRPCNames(spans)
	first := spans[1]
	enrichGenericRPCNames(spans)
	if !spans[1].RPCNameInferred || spans[1].OperationName != first.OperationName {
		t.Fatal("a second pass must not change an already-inferred span")
	}
}

func TestEnrichOneSourceOneGeneric(t *testing.T) {
	spans := []models.Span{
		clientSpan("frontend", "hipstershop.CurrencyService/Convert", "currencyservice", "7000", testBase),
		genericServerSpan("currencyservice", "currencyservice", "7000", testBase+1_000_000),
		genericServerSpan("currencyservice", "currencyservice", "7000", testBase+2_000_000),
	}
	enrichGenericRPCNames(spans)
	inferred := 0
	for _, s := range spans {
		if s.RPCNameInferred {
			inferred++
		}
	}
	if inferred != 1 {
		t.Fatalf("inferred spans = %d, want exactly 1 (a client call pairs with at most one server span)", inferred)
	}
}
