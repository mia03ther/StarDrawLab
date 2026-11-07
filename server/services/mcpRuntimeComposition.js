import { AesGcmCredentialVault, credentialMasterKeyFromEnv } from "../infrastructure/credentialVault.js";
import { McpHttpOAuthAdapter } from "../infrastructure/mcpHttpOAuthAdapter.js";
import { PostgresMcpRepository } from "../infrastructure/postgresMcpRepository.js";
import { McpStreamableHttpTransport } from "../infrastructure/mcpStreamableHttpTransport.js";
import { McpConfigurationService } from "./mcpConfigurationService.js";
import { McpToolExecutionService } from "./mcpToolExecutionService.js";
import { McpOAuthService } from "./mcpOAuthService.js";

let repository;
let vault;
let oauthService;
let configurationService;
let toolExecutionService;

export const getMcpRepository = () => {
  if (!repository) repository = new PostgresMcpRepository();
  return repository;
};

export const getMcpOAuthRuntime = () => {
  if (!oauthService) {
    const credentialVault = getMcpCredentialVault();
    oauthService = new McpOAuthService({
      repository: getMcpRepository(),
      oauth: new McpHttpOAuthAdapter(),
      vault: credentialVault,
    });
  }
  return oauthService;
};

export const getMcpCredentialVault = () => {
  if (!vault) vault = new AesGcmCredentialVault({ masterKey: credentialMasterKeyFromEnv() });
  return vault;
};

export const getMcpConfigurationRuntime = () => {
  if (!configurationService) {
    configurationService = new McpConfigurationService({
      repository: getMcpRepository(),
      vault: getMcpCredentialVault(),
    });
  }
  return configurationService;
};

export const getMcpToolRuntime = () => {
  if (!toolExecutionService) {
    toolExecutionService = new McpToolExecutionService({
      repository: getMcpRepository(),
      oauth: getMcpOAuthRuntime(),
      transport: new McpStreamableHttpTransport(),
    });
  }
  return toolExecutionService;
};

export const resetMcpRuntimeForTests = () => {
  repository = null;
  vault = null;
  oauthService = null;
  configurationService = null;
  toolExecutionService = null;
};
