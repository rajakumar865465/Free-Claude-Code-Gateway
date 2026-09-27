import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderFailoverEngine } from '../src/provider-failover/engine';
import type { FailoverConfig, ProviderStatus, SwitchLogEntry } from '../src/provider-failover/types';
import type { ProviderResponse } from '../src/services/bluesminds.service';
import { CompactionEngine } from '../src/auto-compact/compaction-engine';
import type { OpenAIMessage } from '../src/types/openai';
import { buildModelsRouter } from '../src/routes/models.routes';
import { BluesmindsService } from '../src/services/bluesminds.service';
import { AdminState } from '../src/admin/admin-state';
import { buildAdminApiRouter } from '../src/admin/routes/admin-api.routes';

// ── Test doubles ──────────────────────────────────────────────────────────────
class FakeStorage {
  private config: FailoverConfig = {
    failover_enabled: true,
    health_check_interval: 300,
    max_retries: 3,
    retry_delay_1: 0,
    retry_delay_2: 0,
    alert_on_switch: false,
    cooldown_seconds: 120,
    health_probe_uses_chat: true,
    first_check_delay_seconds: 7,
    startup_grace_seconds: 30,
    failure_threshold: 3,
  };
  private statuses: ProviderStatus[] = [];
  private switchLog: SwitchLogEntry[] = [];

  getConfig(): FailoverConfig { return this.config; }
  saveConfig(c: FailoverConfig): void { this.config = c; }
  getStatuses(): ProviderStatus[] { return this.statuses; }
  saveStatuses(s: ProviderStatus[]): void { this.statuses = s; }
  upsertStatus(s: ProviderStatus): void {
    const i = this.statuses.findIndex((x) => x.id === s.id);
    if (i >= 0) this.statuses[i] = s; else this.statuses.push(s);
  }
  getSwitchLog(): SwitchLogEntry[] { return this.switchLog; }
  appendSwitchLog(e: SwitchLogEntry): void { this.switchLog.unshift(e); }
  clearSwitchLog(): void { this.switchLog = []; }
}

describe('Gateway Audit Fixes Verification', () => {
  describe('Failover Engine: 504 and Bedrock fixes', () => {
    it('immediately triggers cross-provider failover on 504 without 3 retries on dead primary', async () => {
      const storage = new FakeStorage();
      let primaryCalls = 0;
      let alternateCalls = 0;

      const p1 = {
        id: 'primary-p1',
        name: 'Primary',
        type: 'openai',
        baseUrl: 'https://p1.example.com/v1',
        apiKey: 'key1',
        defaultModel: 'model1',
      };
      const p2 = {
        id: 'alt-p2',
        name: 'Alternate Bedrock',
        type: 'aws_bedrock',
        awsRegion: 'us-west-2',
        baseUrl: '',
        apiKey: 'key2',
        defaultModel: 'anthropic.claude-3-5-sonnet',
      };

      const pm = {
        getAll: () => [p1, p2],
        getActive: () => p1,
      };

      const engine = new ProviderFailoverEngine(storage as any, pm as any);

      // Primary returns 504 (gateway timeout)
      const primaryFn = async (): Promise<ProviderResponse<unknown>> => {
        primaryCalls++;
        return { ok: false, status: 504, body: { error: { message: 'Gateway Timeout' } } };
      };

      // Alternate succeeds
      const altFn = async (alt: any): Promise<ProviderResponse<unknown>> => {
        alternateCalls++;
        assert.equal(alt.id, 'alt-p2');
        assert.equal(alt.type, 'aws_bedrock');
        assert.equal(alt.baseUrl, 'https://bedrock-mantle.us-west-2.amazonaws.com/v1');
        return { ok: true, status: 200, body: { choices: [{ message: { content: 'from bedrock' } }] } };
      };

      const result = await engine.executeWithFailover(primaryFn, altFn, {
        providerId: 'primary-p1',
        modelId: 'model1',
      });

      // Primary should have been called ONCE (no 504 retry loops), and failed over immediately
      assert.equal(primaryCalls, 1, 'Primary should be called exactly once on 504 without spinning retries');
      assert.equal(alternateCalls, 1, 'Alternate should be called once');
      assert.equal(result.ok, true);
    });

    it('constructs correct Bedrock mantle endpoint when getting alternates', () => {
      const storage = new FakeStorage();
      const p1 = { id: 'p1', name: 'P1', baseUrl: 'https://p1.com/v1', apiKey: 'k', defaultModel: 'm' };
      const pBedrock = {
        id: 'bedrock-1',
        name: 'AWS Bedrock Oregon',
        type: 'aws_bedrock',
        awsRegion: 'us-west-2',
        baseUrl: '',
        apiKey: 'bedrock-key',
        defaultModel: 'anthropic.claude-v2',
      };

      const pm = {
        getAll: () => [p1, pBedrock],
        getActive: () => p1,
      };

      const engine = new ProviderFailoverEngine(storage as any, pm as any);
      const alts = engine.getAlternateProviders('p1');

      assert.equal(alts.length, 1);
      assert.equal(alts[0].id, 'bedrock-1');
      assert.equal(alts[0].baseUrl, 'https://bedrock-mantle.us-west-2.amazonaws.com/v1');
      assert.equal(alts[0].awsRegion, 'us-west-2');
    });
  });

  describe('Compaction Engine: Tool call invariant boundary preservation', () => {
    it('preserves assistant tool_calls and corresponding tool responses together in toKeep', () => {
      const engine = new CompactionEngine();
      // Access private findSafeCutoff via cast for test
      const findSafeCutoff = (engine as any).findSafeCutoff.bind(engine);

      const messages: OpenAIMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'call tool', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'output' },
        { role: 'user', content: 'next turn' },
      ];

      // If initial cutoff is 2 (at the tool response):
      const cutoffAtTool = findSafeCutoff(messages, 2);
      // Cutoff should pull back to 1 (the assistant message with tool_calls)
      assert.equal(cutoffAtTool, 1, 'Cutoff must include the assistant message that issued the tool calls');

      // If initial cutoff is 3 (at user 'next turn'):
      const cutoffAtUser = findSafeCutoff(messages, 3);
      assert.equal(cutoffAtUser, 3, 'Cutoff at user message is safe and stays at 3');
    });
  });

  describe('Models Router: Synthesis fallback when upstream GET /models fails', () => {
    it('synthesizes models list from registry when upstream returns 404', async () => {
      // Mock BluesmindsService returning 404
      const mockService = {
        listModels: async () => ({ ok: false, status: 404, body: { error: { message: 'Not Found' } } }),
      } as unknown as BluesmindsService;

      // Mock AdminState
      const mockState = {
        modelRegistry: {
          snapshot: () => ({
            mappings: {
              'claude-3-7-sonnet-20250219': 'claude-3-7-sonnet',
            },
            familyRules: [],
            default: 'claude-3-7-sonnet',
          }),
        },
        configManager: {
          getDefaultModel: () => 'claude-3-7-sonnet',
        },
        providerManager: {
          getActive: () => ({
            id: 'bedrock-1',
            name: 'AWS Bedrock',
            defaultModel: 'anthropic.claude-3-5-sonnet',
          }),
        },
      } as unknown as AdminState;

      const router = buildModelsRouter(mockService, mockState);

      // Verify route handler directly
      const routeLayer = (router.stack as any[]).find((layer) => layer.route?.path === '/v1/models');
      assert.ok(routeLayer, 'Route /v1/models should be registered');

      let responseStatus = 0;
      let responseBody: any = null;

      const fakeReq = {} as any;
      const fakeRes = {
        status: (s: number) => {
          responseStatus = s;
          return fakeRes;
        },
        json: (b: any) => {
          responseBody = b;
          return fakeRes;
        },
      } as any;

      await routeLayer.route.stack[0].handle(fakeReq, fakeRes);

      assert.equal(responseStatus, 200, 'Should return 200 synthesized response instead of 404');
      assert.equal(responseBody.object, 'list');
      assert.ok(Array.isArray(responseBody.data));
      const ids = responseBody.data.map((m: any) => m.id);
      assert.ok(ids.includes('claude-3-7-sonnet'));
      assert.ok(ids.includes('anthropic.claude-3-5-sonnet'));
    });

    it('returns models in Claude Desktop Discovery format with type: model, display_name, created_at', async () => {
      const mockService = {
        listModels: async () => ({ ok: true, status: 200, body: { data: [{ id: 'upstream/m1' }] } }),
      } as unknown as BluesmindsService;

      const mockState = {
        modelRegistry: { snapshot: () => ({ mappings: {}, familyRules: [], default: 'moonshotai/kimi-k3' }) },
        configManager: { getDefaultModel: () => 'moonshotai/kimi-k3' },
        providerManager: { getActive: () => null },
      } as unknown as AdminState;

      const router = buildModelsRouter(mockService, mockState);
      const routeLayer = (router.stack as any[]).find((layer) => layer.route?.path === '/v1/models');
      assert.ok(routeLayer);

      let responseBody: any = null;
      const fakeReq = {} as any;
      const fakeRes = {
        status: () => fakeRes,
        json: (b: any) => { responseBody = b; return fakeRes; },
      } as any;

      await routeLayer.route.stack[0].handle(fakeReq, fakeRes);

      assert.equal(responseBody.object, 'list');
      assert.equal(responseBody.has_more, false);
      const sonnet = responseBody.data.find((m: any) => m.id === 'claude-sonnet-5');
      assert.ok(sonnet, 'claude-sonnet-5 must be present');
      assert.equal(sonnet.type, 'model', 'Anthropic requires type: model');
      assert.equal(sonnet.object, 'model', 'OpenAI requires object: model');
      assert.equal(sonnet.display_name, 'Claude Sonnet 5');
      assert.ok(sonnet.created_at, 'Anthropic requires created_at');

      const sonnet37 = responseBody.data.find((m: any) => m.id === 'claude-3-7-sonnet-20250219');
      assert.ok(sonnet37, 'claude-3-7-sonnet-20250219 must be present');
      assert.equal(sonnet37.display_name, 'Claude 3.7 Sonnet');
    });

    it('handles single model query /v1/models/:model_id', async () => {
      const mockService = { listModels: async () => ({ ok: true, status: 200, body: {} }) } as unknown as BluesmindsService;
      const mockState = {
        modelRegistry: { snapshot: () => ({ mappings: {}, familyRules: [], default: 'm' }) },
        configManager: { getDefaultModel: () => 'm' },
        providerManager: { getActive: () => null },
      } as unknown as AdminState;

      const router = buildModelsRouter(mockService, mockState);
      const routeLayer = (router.stack as any[]).find((layer) => layer.route?.path === '/v1/models/:model_id');
      assert.ok(routeLayer, '/v1/models/:model_id route must be registered');

      let responseBody: any = null;
      const fakeReq = { params: { model_id: 'claude-sonnet-5' } } as any;
      const fakeRes = {
        status: () => fakeRes,
        json: (b: any) => { responseBody = b; return fakeRes; },
      } as any;

      await routeLayer.route.stack[0].handle(fakeReq, fakeRes);

      assert.equal(responseBody.id, 'claude-sonnet-5');
      assert.equal(responseBody.type, 'model');
      assert.equal(responseBody.display_name, 'Claude Sonnet 5');
    });

    it('has /v1/v1/models route registered to eliminate 404 for doubled prefix', () => {
      const mockService = {} as unknown as BluesmindsService;
      const mockState = {} as unknown as AdminState;
      const router = buildModelsRouter(mockService, mockState);
      const routeLayer = (router.stack as any[]).find((layer) => layer.route?.path === '/v1/v1/models');
      assert.ok(routeLayer, '/v1/v1/models must be registered');
    });
  });

  describe('Automatic Model Router Sync on Provider Switch & Update', () => {
    it('automatically remaps model registry mappings and default when switching active provider', async () => {
      const state = new AdminState();
      const pA = state.providerManager.add({
        name: 'Provider A',
        baseUrl: 'https://example.com/v1',
        apiKey: 'key-a',
        defaultModel: 'model-a-original',
      });
      const pB = state.providerManager.add({
        name: 'Provider B',
        baseUrl: 'https://example.com/v1',
        apiKey: 'key-b',
        defaultModel: 'z-ai/glm-5.3',
      });

      const router = buildAdminApiRouter(state);
      const activateLayer = (router.stack as any[]).find(
        (l) => l.route?.path === '/providers/:id/activate' && l.route?.methods?.post,
      );
      assert.ok(activateLayer, '/providers/:id/activate route must exist');

      // 1. Activate Provider A
      let resA: any = null;
      const fakeResA = {
        status: () => fakeResA,
        json: (b: any) => { resA = b; return fakeResA; },
      } as any;
      await activateLayer.route.stack[0].handle({ params: { id: pA.id } }, fakeResA);

      // Verify Provider A model is active and mapped
      assert.equal(state.configManager.getDefaultModel(), 'model-a-original');
      assert.equal(state.modelRegistry.snapshot().default, 'model-a-original');
      assert.equal(state.modelRegistry.snapshot().mappings['claude-sonnet-5'], 'model-a-original');

      // 2. Activate Provider B (with model z-ai/glm-5.3)
      let resB: any = null;
      const fakeResB = {
        status: () => fakeResB,
        json: (b: any) => { resB = b; return fakeResB; },
      } as any;
      await activateLayer.route.stack[0].handle({ params: { id: pB.id } }, fakeResB);

      // Verify Provider B model is automatically synced and remapped without clicking sync!
      assert.equal(state.configManager.getDefaultModel(), 'z-ai/glm-5.3');
      assert.equal(state.modelRegistry.snapshot().default, 'z-ai/glm-5.3');
      assert.equal(state.modelRegistry.snapshot().mappings['claude-sonnet-5'], 'z-ai/glm-5.3');
      assert.equal(state.modelRegistry.snapshot().mappings['claude-3-7-sonnet-20250219'], 'z-ai/glm-5.3');

      // Clean up test providers
      try {
        state.providerManager.setActive(null);
        state.providerManager.delete(pA.id);
        state.providerManager.delete(pB.id);
      } catch {}
    });

    it('automatically remaps router when active provider default model is updated', async () => {
      const state = new AdminState();
      const p = state.providerManager.add({
        name: 'Provider Editable',
        baseUrl: 'https://example.com/v1',
        apiKey: 'key-test',
        defaultModel: 'old-model-val',
      });
      state.providerManager.setActive(p.id);

      const router = buildAdminApiRouter(state);
      const updateLayer = (router.stack as any[]).find(
        (l) => l.route?.path === '/providers/:id' && l.route?.methods?.put,
      );
      assert.ok(updateLayer, '/providers/:id PUT route must exist');

      let resUpdate: any = null;
      const fakeRes = {
        status: () => fakeRes,
        json: (b: any) => { resUpdate = b; return fakeRes; },
      } as any;

      await updateLayer.route.stack[0].handle(
        { params: { id: p.id }, body: { defaultModel: 'z-ai/glm-5.3-flash' } },
        fakeRes,
      );

      // Verify router is automatically remapped
      assert.equal(state.configManager.getDefaultModel(), 'z-ai/glm-5.3-flash');
      assert.equal(state.modelRegistry.snapshot().default, 'z-ai/glm-5.3-flash');
      assert.equal(state.modelRegistry.snapshot().mappings['claude-sonnet-5'], 'z-ai/glm-5.3-flash');

      // Clean up
      try {
        state.providerManager.setActive(null);
        state.providerManager.delete(p.id);
      } catch {}
    });
  });
});
