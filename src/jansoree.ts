/**
 * Secondary GitHub App client for the Jansoree review identity.
 *
 * The primary Seori app keeps the required check and acceptance-guide threads;
 * Jansoree only posts advisory defect comments, so this client resolves the
 * Jansoree installation per repository and never touches webhooks.
 */
import { App } from "octokit";
import type { Config } from "./config.js";
import type { RepoRef } from "./github.js";

type Octokit = any;

type Logger = {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
};

export type JansoreeApp = {
  octokit: { rest: { apps: { getRepoInstallation: (params: { owner: string; repo: string }) => Promise<{ data: { id: number } }> } } };
  getInstallationOctokit: (installationId: number) => Promise<Octokit>;
};

const INSTALLATION_CACHE_TTL_MS = 60 * 60 * 1000;
const MISSING_INSTALLATION_CACHE_TTL_MS = 10 * 60 * 1000;

export class JansoreeClient {
  private readonly cache = new Map<string, { octokit: Octokit | null; expiresAt: number }>();
  private app: JansoreeApp | null | undefined;

  constructor(
    private readonly config: Config,
    private readonly logger?: Logger,
    private readonly appFactory?: (appId: string, privateKey: string) => JansoreeApp,
  ) {}

  available(): boolean {
    return Boolean(this.config.reviewGithubAppId && this.config.reviewGithubPrivateKey);
  }

  async octokitFor(repo: RepoRef): Promise<Octokit | null> {
    const app = this.appInstance();
    if (!app) {
      return null;
    }

    const key = repo.fullName.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.octokit;
    }

    try {
      const installation = await app.octokit.rest.apps.getRepoInstallation({
        owner: repo.owner,
        repo: repo.repo,
      });
      const octokit = await app.getInstallationOctokit(installation.data.id);
      this.cache.set(key, { octokit, expiresAt: Date.now() + INSTALLATION_CACHE_TTL_MS });
      return octokit;
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        this.cache.set(key, { octokit: null, expiresAt: Date.now() + MISSING_INSTALLATION_CACHE_TTL_MS });
        this.logger?.warn({ repo: repo.fullName }, "Jansoree app installation not found; advisory disabled for repo");
        return null;
      }
      throw error;
    }
  }

  private appInstance(): JansoreeApp | null {
    if (!this.available()) {
      return null;
    }
    if (this.app === undefined) {
      const factory =
        this.appFactory ??
        ((appId: string, privateKey: string) => new App({ appId, privateKey }) as unknown as JansoreeApp);
      this.app = factory(this.config.reviewGithubAppId!, this.config.reviewGithubPrivateKey!);
    }
    return this.app;
  }
}
