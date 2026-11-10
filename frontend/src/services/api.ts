import {
  HealthResponse,
  Topology,
  Service,
  Endpoint,
  Trace,
  LogEntry,
  KubernetesEvent,
  ClusterInfo,
  UISettings,
  Baseline,
} from '../types/api';

const BASE_URL = '/api/v1';
const API_TOKEN_KEY = 'kubevision.apiToken';

async function fetchMutation(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const request = (token: string | null) => {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };

  let token = sessionStorage.getItem(API_TOKEN_KEY);
  let response = await request(token);
  if (response.status === 401) {
    const entered = window.prompt('Enter the KubeVision API token to make this change:');
    if (entered?.trim()) {
      token = entered.trim();
      sessionStorage.setItem(API_TOKEN_KEY, token);
      response = await request(token);
    }
  }
  return response;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let errorMsg = `HTTP Error ${res.status}: ${res.statusText}`;
    try {
      const json = await res.json();
      if (json.error) errorMsg = json.error;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }
  return res.json();
}

export const api = {
  async getHealth(): Promise<HealthResponse> {
    const res = await fetch(`${BASE_URL}/health`);
    return handleResponse<HealthResponse>(res);
  },

  async getTopology(namespace?: string, window?: string): Promise<Topology> {
    const params = new URLSearchParams();
    if (namespace) params.set('namespace', namespace);
    if (window) params.set('window', window);
    const res = await fetch(`${BASE_URL}/topology?${params.toString()}`);
    return handleResponse<Topology>(res);
  },

  async getServices(namespace?: string, window?: string): Promise<Service[]> {
    const params = new URLSearchParams();
    if (namespace) params.set('namespace', namespace);
    if (window) params.set('window', window);
    const res = await fetch(`${BASE_URL}/services?${params.toString()}`);
    return handleResponse<Service[]>(res).then((d) => d ?? []);
  },

  async getServiceEndpoints(name: string, namespace?: string, window?: string): Promise<Endpoint[]> {
    const params = new URLSearchParams();
    if (namespace) params.set('namespace', namespace);
    if (window) params.set('window', window);
    const res = await fetch(`${BASE_URL}/services/${encodeURIComponent(name)}/endpoints?${params.toString()}`);
    return handleResponse<Endpoint[]>(res).then((d) => d ?? []);
  },

  async getBaselines(serviceName: string, window?: string): Promise<Baseline[]> {
    const params = new URLSearchParams();
    if (window) params.set('window', window);
    const res = await fetch(`${BASE_URL}/services/${encodeURIComponent(serviceName)}/baselines?${params.toString()}`);
    return handleResponse<Baseline[]>(res).then((d) => d ?? []);
  },

  async recalculateBaselines(namespace?: string, window?: string): Promise<{ status: string; message: string }> {
    const params = new URLSearchParams();
    if (namespace) params.set('namespace', namespace);
    if (window) params.set('window', window);
    const res = await fetchMutation(`${BASE_URL}/baselines/recalculate?${params.toString()}`, {
      method: 'POST',
    });
    return handleResponse<{ status: string; message: string }>(res);
  },

  async getTraces(serviceName?: string, limit: number = 25, window?: string): Promise<Trace[]> {
    const params = new URLSearchParams();
    if (serviceName) params.set('serviceName', serviceName);
    params.set('limit', limit.toString());
    if (window) params.set('window', window);
    const res = await fetch(`${BASE_URL}/traces?${params.toString()}`);
    return handleResponse<Trace[]>(res).then((d) => d ?? []);
  },

  async getTraceDetail(traceId: string): Promise<Trace> {
    const res = await fetch(`${BASE_URL}/traces/${encodeURIComponent(traceId)}`);
    return handleResponse<Trace>(res);
  },

  async getLogs(params: {
    namespace?: string;
    pod?: string;
    filter?: string;
    limit?: number;
    start?: string;
    end?: string;
  }): Promise<LogEntry[]> {
    const query = new URLSearchParams();
    if (params.namespace) query.set('namespace', params.namespace);
    if (params.pod) query.set('pod', params.pod);
    if (params.filter) query.set('filter', params.filter);
    if (params.limit) query.set('limit', params.limit.toString());
    if (params.start) query.set('start', params.start);
    if (params.end) query.set('end', params.end);

    const res = await fetch(`${BASE_URL}/logs?${query.toString()}`);
    return handleResponse<LogEntry[]>(res).then((d) => d ?? []);
  },

  async getConfig(): Promise<UISettings> {
    const res = await fetch(`${BASE_URL}/config`);
    return handleResponse<UISettings>(res);
  },

  async updateConfig(settings: UISettings): Promise<UISettings> {
    const res = await fetchMutation(`${BASE_URL}/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(settings),
    });
    return handleResponse<UISettings>(res);
  },

  async getClusterInfo(): Promise<ClusterInfo> {
    const res = await fetch(`${BASE_URL}/cluster`);
    return handleResponse<ClusterInfo>(res);
  },

  async getNamespaces(): Promise<string[]> {
    const res = await fetch(`${BASE_URL}/namespaces`);
    return handleResponse<string[]>(res).then((d) => d ?? []);
  },

  async getKubernetesEvents(namespace?: string, limit: number = 100): Promise<KubernetesEvent[]> {
    const params = new URLSearchParams({ limit: limit.toString() });
    if (namespace) params.set('namespace', namespace);
    const res = await fetch(`${BASE_URL}/events?${params.toString()}`);
    return handleResponse<KubernetesEvent[]>(res).then((d) => d ?? []);
  },
};
