import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
const state = { queries: [], rules: [] };
globalThis.__templatePricingTest = state;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/services/pointsService.js') && specifier === '../configs/db.js') return { shortCircuit: true, url: 'template-pricing-test:db' };
    if (context.parentURL?.endsWith('/services/pointsService.js') && specifier === '../configs/logger.js') return { shortCircuit: true, url: 'template-pricing-test:log' };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'template-pricing-test:db') return {format:'module',shortCircuit:true,source:`export default (parts,...values) => { globalThis.__templatePricingTest.queries.push({text:parts.join('?'),values}); return globalThis.__templatePricingTest.rules; };`};
    if (url === 'template-pricing-test:log') return {format:'module',shortCircuit:true,source:'export default {info(){},warn(){},error(){}};'};
    return next(url, context);
  },
});
const { resolveCharge, resolveChargeRule } = await import('../services/pointsService.js');
const { normalizeTemplateRow } = await import('../utils/templateData.js');

test('every media template uses18 across routes, size, duration and legacy rule types', async () => {
  state.queries = [];
  state.rules = [{points_cost:999,meta_rule:{billing_type:'per_minute',points_per_minute:999}}];
  for (const outputType of ['image','video']) {
    for (const provider of ['image_provider','sora','heygen_video_agent']) {
      assert.equal(await resolveCharge({outputType,provider,sceneKey:'user_template',model:'chosen-model',seconds:180,size:'4096x4096'}),18);
      assert.equal(await resolveCharge({outputType,provider,sceneKey:'user_template',generationMode:'freeform'}),18);
    }
  }
  assert.equal(state.queries.length,0);
  const rule=await resolveChargeRule({outputType:'video',provider:'sora',sceneKey:'template',seconds:8});
  assert.equal(rule.generation_mode,'template');assert.equal(rule.meta_rule.billing_type,'fixed');
});

test('freeform and non-media operations retain legacy pricing and cannot spoof template mode',async()=>{
  state.queries=[];state.rules=[{points_cost:150,meta_rule:{billing_type:'fixed'}}];
  assert.equal(await resolveCharge({outputType:'video',provider:'sora',sceneKey:'freeform_video',generationMode:'template'}),150);
  assert(state.queries[0].values.includes('freeform'));
  state.rules=[{points_cost:32,meta_rule:{billing_type:'fixed'}}];
  assert.equal(await resolveCharge({outputType:'image',provider:'image_provider',sceneKey:'freeform_image'}),32);
  state.rules=[{points_cost:3,meta_rule:{billing_type:'token_usage',minimum_points:3}}];
  assert.equal(await resolveCharge({outputType:'agent',provider:'canvas_agent',sceneKey:'canvas_agent'}),3);
  state.rules=[{points_cost:60,meta_rule:{billing_type:'per_minute',points_per_minute:60}}];
  assert.equal(await resolveCharge({outputType:'video',provider:'sora',sceneKey:'freeform_video',seconds:90}),90);
});

test('template catalogs show the exact18 charged while keeping saved rendering settings',()=>{
  const row={id:12,scene_key:'old_video',output_type:'video',points_cost:160,estimated_points:200,billing_type:'per_minute',points_per_minute:60,default_model:'legacy-model',default_size:'1280x720',default_seconds:8,system_prompt:'keep me'};
  const normalized=normalizeTemplateRow(row);
  assert.equal(normalized.points_cost,18);assert.equal(normalized.estimated_points,18);
  assert.equal(normalized.billing_type,'fixed');assert.equal(normalized.points_per_minute,null);
  for(const key of ['default_model','default_size','default_seconds','system_prompt'])assert.equal(normalized[key],row[key]);
  assert.equal(normalizeTemplateRow({...row,scene_key:'freeform_video'}).points_cost,160);
  assert.equal(row.points_cost,160,'normalization must not rewrite historical database rows');
});
