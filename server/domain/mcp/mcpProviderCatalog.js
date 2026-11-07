/**
 * Provider capability catalog.
 *
 * This is deliberately provider-neutral at the core seam: OAuth endpoints,
 * client identifiers and scopes are discovered/configured per MCP server and
 * never guessed from a provider name. The catalog only describes what this
 * release is willing to admit and the invariants the application can enforce.
 */

export const MCP_PROVIDER_ADMISSION = Object.freeze({
  SUPPORTED: "supported",
  CATALOG_PENDING: "catalog_pending",
});

const immutable = (value) => Object.freeze(value);

const CATALOG = {
  notion: {
    providerAdapter: "notion",
    displayName: "Notion",
    admission: MCP_PROVIDER_ADMISSION.SUPPORTED,
    reasonCode: null,
    officialRemoteEndpoints: ["https://mcp.notion.com/mcp", "https://mcp.notion.com/sse"],
    providerTransports: ["streamable_http", "sse"],
    supportedTransports: ["streamable_http"],
    oauth: {
      authorizationCodePkce: true,
      protectedResourceDiscovery: true,
      authorizationServerDiscovery: true,
      resourceIndicator: true,
      refreshTokens: true,
      clientRegistration: ["manual", "pre_registered", "client_id_metadata", "dynamic_registration"],
      scopeSource: "provider_metadata",
      scopeDefaults: ["default"],
    },
    configuration: {
      endpointSource: "root_configured",
      issuerSource: "protected_resource_discovery",
      perUserAuthorization: true,
    },
  },
  github: {
    providerAdapter: "github",
    displayName: "GitHub",
    admission: MCP_PROVIDER_ADMISSION.SUPPORTED,
    reasonCode: null,
    officialRemoteEndpoints: ["https://api.githubcopilot.com/mcp/"],
    providerTransports: ["streamable_http"],
    supportedTransports: ["streamable_http"],
    oauth: {
      authorizationCodePkce: true,
      protectedResourceDiscovery: true,
      authorizationServerDiscovery: true,
      resourceIndicator: true,
      refreshTokens: true,
      clientRegistration: ["manual", "pre_registered"],
      scopeSource: "root_allowlist",
      scopeDefaults: [],
    },
    configuration: {
      endpointSource: "root_configured",
      issuerSource: "protected_resource_discovery",
      perUserAuthorization: true,
      leastPrivilege: true,
    },
  },
  generic_oauth21: {
    providerAdapter: "generic_oauth21",
    displayName: "Generic OAuth 2.1 MCP",
    admission: MCP_PROVIDER_ADMISSION.SUPPORTED,
    reasonCode: null,
    officialRemoteEndpoints: [],
    providerTransports: ["streamable_http"],
    supportedTransports: ["streamable_http"],
    oauth: {
      authorizationCodePkce: true,
      protectedResourceDiscovery: true,
      authorizationServerDiscovery: true,
      resourceIndicator: true,
      refreshTokens: true,
      clientRegistration: ["manual", "pre_registered", "client_id_metadata", "dynamic_registration"],
      scopeSource: "root_allowlist",
      scopeDefaults: [],
    },
    configuration: {
      endpointSource: "root_configured",
      issuerSource: "protected_resource_discovery_or_root_registration",
      perUserAuthorization: true,
      leastPrivilege: true,
      rootManaged: true,
    },
  },
  figma: {
    providerAdapter: "figma",
    displayName: "Figma",
    admission: MCP_PROVIDER_ADMISSION.CATALOG_PENDING,
    reasonCode: "MCP_FIGMA_CATALOG_PENDING",
    officialRemoteEndpoints: ["https://mcp.figma.com/mcp"],
    providerTransports: ["streamable_http"],
    supportedTransports: ["streamable_http"],
    oauth: {
      authorizationCodePkce: true,
      protectedResourceDiscovery: true,
      authorizationServerDiscovery: true,
      resourceIndicator: true,
      refreshTokens: true,
      clientRegistration: ["manual", "pre_registered", "client_id_metadata", "dynamic_registration"],
      scopeSource: "provider_metadata",
      scopeDefaults: ["mcp:connect"],
    },
    configuration: {
      endpointSource: "root_configured",
      issuerSource: "protected_resource_discovery",
      perUserAuthorization: true,
    },
  },
};

for (const capability of Object.values(CATALOG)) {
  capability.officialRemoteEndpoints = immutable([...capability.officialRemoteEndpoints]);
  capability.providerTransports = immutable([...capability.providerTransports]);
  capability.supportedTransports = immutable([...capability.supportedTransports]);
  capability.oauth = immutable({
    ...capability.oauth,
    clientRegistration: immutable([...capability.oauth.clientRegistration]),
    scopeDefaults: immutable([...capability.oauth.scopeDefaults]),
  });
  capability.configuration = immutable({ ...capability.configuration });
  Object.freeze(capability);
}

Object.freeze(CATALOG);

export const MCP_PROVIDER_ADAPTERS = Object.freeze(Object.keys(CATALOG));

const fail = (message, { status = 400, code = "INVALID_MCP_PROVIDER_CONFIGURATION" } = {}) => {
  throw Object.assign(new Error(message), { status, code });
};

export const getMcpProviderCapability = (providerAdapter) => {
  const key = String(providerAdapter || "").trim().toLowerCase();
  return CATALOG[key] || null;
};

export const listMcpProviderCapabilities = () => Object.values(CATALOG).map((capability) => ({
  ...capability,
  officialRemoteEndpoints: [...capability.officialRemoteEndpoints],
  providerTransports: [...capability.providerTransports],
  supportedTransports: [...capability.supportedTransports],
  oauth: {
    ...capability.oauth,
    clientRegistration: [...capability.oauth.clientRegistration],
    scopeDefaults: [...capability.oauth.scopeDefaults],
  },
  configuration: { ...capability.configuration },
}));

export const assertMcpProviderConfiguration = ({ providerAdapter, transport, status, enabled = false } = {}) => {
  const capability = getMcpProviderCapability(providerAdapter);
  if (!capability) fail("This MCP provider is not on the root allowlist", {
    status: 403,
    code: "MCP_PROVIDER_NOT_ALLOWED",
  });

  const normalizedTransport = String(transport || "streamable_http").trim().toLowerCase();
  if (!capability.supportedTransports.includes(normalizedTransport)) {
    fail(`${capability.displayName} MCP does not support this transport in the current release`, {
      status: 503,
      code: "MCP_PROVIDER_TRANSPORT_UNAVAILABLE",
    });
  }

  const normalizedStatus = String(status || "draft").trim().toLowerCase();
  if (capability.admission === MCP_PROVIDER_ADMISSION.CATALOG_PENDING
      && (normalizedStatus === "enabled" || enabled === true)) {
    fail(`${capability.displayName} MCP is awaiting provider capability admission`, {
      status: 409,
      code: capability.reasonCode,
    });
  }
  return capability;
};
