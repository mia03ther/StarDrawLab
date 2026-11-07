const DEFAULT_TOOL_LIMIT = 24;
const MAX_SEARCH_RESULTS = 40;

const clean = (value, max = 2000) => String(value ?? "").trim().slice(0, max);
const toolKey = (tool) => clean(tool?.toolKey, 128).toLowerCase();
const toolFamily = (tool) => toolKey(tool).split(".")[0];

const FAMILY_HINTS = Object.freeze([
  { pattern: /(工作流|流程|节点|编排|workflow|pipeline)/i, families: ["workflow", "canvas"] },
  { pattern: /(画布|白板|元素|便签|排版|canvas|board)/i, families: ["canvas", "workflow", "storyboard", "timeline", "director3d"] },
  { pattern: /(分镜|镜头|shot|storyboard)/i, families: ["storyboard", "canvas", "workflow"] },
  { pattern: /(剪辑|时间线|字幕|转场|timeline|edit video)/i, families: ["timeline", "canvas", "workflow"] },
  { pattern: /(3d|导演台|场景|director)/i, families: ["director3d", "canvas"] },
  { pattern: /(生图|图片|图像|海报|image|photo|picture)/i, families: ["media", "model", "template", "creation", "visual-parameter"] },
  { pattern: /(视频|影片|短片|video|film)/i, families: ["media", "model", "template", "creation", "task"] },
  { pattern: /(模板|模版|template)/i, families: ["template"] },
  { pattern: /(作品|历史|下载|导出|creation|history|download)/i, families: ["creation", "task"] },
  { pattern: /(任务|进度|取消|task|progress)/i, families: ["task", "workflow", "creation"] },
  { pattern: /(社区|公开|发布|点赞|收藏|举报|community|publish|favorite|like)/i, families: ["community", "content"] },
  { pattern: /(积分|余额|账单|会员|套餐|订阅|支付|退款|points|balance|billing|subscription|refund)/i, families: ["account", "subscription", "point-package", "billing"] },
  { pattern: /(个人资料|头像|profile|avatar)/i, families: ["profile"] },
  { pattern: /(删除|回收站|恢复|通知|delete|recycle|restore|notification)/i, families: ["content", "creation", "task"] },
  { pattern: /(数字人|口播|digital human|avatar video)/i, families: ["digital-human"] },
  { pattern: /(mcp|figma|notion|github|外部工具|oauth)/i, families: ["mcp", "admin", "root"] },
  { pattern: /(管理员|用户管理|审核|审计|admin|moderation|audit)/i, families: ["admin", "root"] },
  { pattern: /(模型路由|模型配置|限流|速率|并发|root|model route|rate limit)/i, families: ["root", "model"] },
]);

const FALLBACK_KEYS = new Set([
  "agent.capability.search",
  "canvas.list",
  "canvas.read",
  "template.search",
  "template.use",
  "model.list",
  "media.estimate",
  "media.generate.image",
  "media.generate.video",
  "creation.history",
  "creation.get",
  "task.list",
  "task.get",
  "account.balance",
  "profile.read",
]);

const tokenize = (value) => {
  const normalized = clean(value, 4000).toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9._:-]{1,48}|[\u3400-\u9fff]{2,16}/g) || []);
  for (const token of [...tokens]) {
    if (!/[\u3400-\u9fff]/.test(token) || token.length < 3) continue;
    for (let index = 0; index < token.length - 1; index += 1) tokens.add(token.slice(index, index + 2));
  }
  return [...tokens].slice(0, 80);
};

const permittedForRole = (tool, userRole) => {
  const requiredRoles = Array.isArray(tool?.requiredRoles) && tool.requiredRoles.length > 0
    ? tool.requiredRoles
    : ["root", "admin", "user"];
  return requiredRoles.includes(String(userRole || "user").toLowerCase());
};

const observedToolKeys = (context = {}) => {
  const keys = new Set();
  for (const observation of Array.isArray(context?.observations) ? context.observations : []) {
    const observedKey = clean(observation?.toolKey, 128).toLowerCase();
    if (observedKey) keys.add(observedKey);
    const discovered = observation?.result?.tools;
    if (!Array.isArray(discovered)) continue;
    for (const tool of discovered) {
      const discoveredKey = clean(tool?.toolKey, 128).toLowerCase();
      if (discoveredKey) keys.add(discoveredKey);
    }
  }
  return keys;
};

const matchedFamilies = (query) => {
  const families = new Set();
  for (const hint of FAMILY_HINTS) {
    if (hint.pattern.test(query)) hint.families.forEach((family) => families.add(family));
  }
  return families;
};

const scoreTool = ({ tool, query, tokens, families, observedKeys, currentCanvas }) => {
  const key = toolKey(tool);
  const family = toolFamily(tool);
  const haystack = `${key} ${clean(tool?.name, 200)} ${clean(tool?.description, 1000)}`.toLowerCase();
  let score = key === "agent.capability.search" ? 10_000 : 0;
  if (observedKeys.has(key)) score += 900;
  if ([...observedKeys].some((observed) => observed.split(".")[0] === family)) score += 90;
  if (families.has(family)) score += 400;
  if (currentCanvas && ["canvas", "workflow", "storyboard", "timeline", "director3d"].includes(family)) score += 45;
  if (FALLBACK_KEYS.has(key)) score += 15;
  for (const token of tokens) {
    if (key.includes(token)) score += 80;
    else if (haystack.includes(token)) score += 18;
  }
  if (query && haystack.includes(query)) score += 250;
  return score;
};

const rankTools = ({ tools, query, context = {}, userRole = null }) => {
  const normalizedQuery = clean(query, 4000).toLowerCase();
  const tokens = tokenize(normalizedQuery);
  const families = matchedFamilies(normalizedQuery);
  const observedKeys = observedToolKeys(context);
  const currentCanvas = Boolean(context?.currentCanvas?.id);
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => toolKey(tool) && (!userRole || permittedForRole(tool, userRole)))
    .map((tool, index) => ({
      tool,
      index,
      score: scoreTool({ tool, query: normalizedQuery, tokens, families, observedKeys, currentCanvas }),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
};

/** Keep each ReAct turn focused while retaining a route to every capability. */
export const selectAgentTools = ({ tools, instruction, context = {}, limit = DEFAULT_TOOL_LIMIT } = {}) => {
  const boundedLimit = Math.max(8, Math.min(40, Number(limit) || DEFAULT_TOOL_LIMIT));
  const ranked = rankTools({ tools, query: instruction, context });
  const relevant = ranked.filter((entry) => entry.score > 0).slice(0, boundedLimit);
  if (relevant.length >= Math.min(8, ranked.length)) return relevant.map((entry) => entry.tool);

  const selectedKeys = new Set(relevant.map((entry) => toolKey(entry.tool)));
  for (const entry of ranked) {
    if (relevant.length >= boundedLimit) break;
    const key = toolKey(entry.tool);
    if (selectedKeys.has(key) || !FALLBACK_KEYS.has(key)) continue;
    selectedKeys.add(key);
    relevant.push(entry);
  }
  return relevant.slice(0, boundedLimit).map((entry) => entry.tool);
};

export const searchAgentCapabilities = ({ tools, query, userRole = "user", limit = 12 } = {}) => {
  const boundedLimit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(limit) || 12));
  return rankTools({ tools, query, userRole })
    .filter((entry) => entry.score > 0 && toolKey(entry.tool) !== "agent.capability.search")
    .slice(0, boundedLimit)
    .map(({ tool }) => ({
      toolKey: tool.toolKey,
      name: tool.name,
      description: tool.description,
      operationClass: tool.operationClass,
      inputSchema: tool.inputSchema || null,
    }));
};

export const AGENT_DISCLOSED_TOOL_LIMIT = DEFAULT_TOOL_LIMIT;
