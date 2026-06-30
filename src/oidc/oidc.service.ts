import { Injectable, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { DbService } from '../db/db.service';
import { UsersService } from '../users/users.service';

export interface OidcProvider {
  id: number;
  name: string;
  providerType: string;
  isEnabled: boolean;
  clientId: string | null;
  clientSecret: string | null;
  discoveryUrl: string | null;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  userinfoEndpoint: string | null;
  scopes: string;
  botToken: string | null;
  botUsername: string | null;
  buttonText: string;
}

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

// In-memory OIDC state store (for dev; use Redis in production)
const stateStore = new Map<string, { providerId: number; expiresAt: number }>();

const GOOGLE_DISCOVERY = 'https://accounts.google.com/.well-known/openid-configuration';

@Injectable()
export class OidcService {
  constructor(
    private readonly db: DbService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async listProviders(): Promise<OidcProvider[]> {
    const { rows } = await this.db.query<any>('SELECT * FROM oidc_providers ORDER BY id');
    return rows.map(this.rowToProvider);
  }

  async getProvider(id: number): Promise<OidcProvider> {
    const { rows } = await this.db.query<any>('SELECT * FROM oidc_providers WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundException('Provider not found');
    return this.rowToProvider(rows[0]);
  }

  async createProvider(dto: Partial<OidcProvider>): Promise<OidcProvider> {
    const discoveryUrl = dto.providerType === 'google' ? GOOGLE_DISCOVERY : (dto.discoveryUrl ?? null);
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO oidc_providers
         (name, provider_type, is_enabled, client_id, client_secret, discovery_url,
          authorization_endpoint, token_endpoint, userinfo_endpoint, scopes,
          bot_token, bot_username, button_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        dto.name, dto.providerType, dto.isEnabled ?? true,
        dto.clientId ?? null, dto.clientSecret ?? null, discoveryUrl,
        dto.authorizationEndpoint ?? null, dto.tokenEndpoint ?? null,
        dto.userinfoEndpoint ?? null, dto.scopes ?? 'openid email profile',
        dto.botToken ?? null, dto.botUsername ?? null, dto.buttonText ?? 'Sign in',
      ],
    );
    return this.getProvider(rows[0].id);
  }

  async updateProvider(id: number, dto: Partial<OidcProvider>): Promise<OidcProvider> {
    await this.getProvider(id);
    const discoveryUrl = dto.providerType === 'google' ? GOOGLE_DISCOVERY : (dto.discoveryUrl ?? null);
    await this.db.query(
      `UPDATE oidc_providers SET
         name                   = COALESCE($1, name),
         provider_type          = COALESCE($2, provider_type),
         is_enabled             = COALESCE($3, is_enabled),
         client_id              = COALESCE($4, client_id),
         client_secret          = COALESCE($5, client_secret),
         discovery_url          = COALESCE($6, discovery_url),
         authorization_endpoint = COALESCE($7, authorization_endpoint),
         token_endpoint         = COALESCE($8, token_endpoint),
         userinfo_endpoint      = COALESCE($9, userinfo_endpoint),
         scopes                 = COALESCE($10, scopes),
         bot_token              = COALESCE($11, bot_token),
         bot_username           = COALESCE($12, bot_username),
         button_text            = COALESCE($13, button_text),
         updated_at             = NOW()
       WHERE id = $14`,
      [
        dto.name ?? null, dto.providerType ?? null, dto.isEnabled ?? null,
        dto.clientId ?? null, dto.clientSecret ?? null, discoveryUrl,
        dto.authorizationEndpoint ?? null, dto.tokenEndpoint ?? null,
        dto.userinfoEndpoint ?? null, dto.scopes ?? null,
        dto.botToken ?? null, dto.botUsername ?? null, dto.buttonText ?? null, id,
      ],
    );
    return this.getProvider(id);
  }

  async deleteProvider(id: number): Promise<void> {
    await this.db.query('DELETE FROM oidc_providers WHERE id = $1', [id]);
  }

  async buildAuthorizationUrl(providerId: number): Promise<string> {
    const provider = await this.getProvider(providerId);
    if (!provider.isEnabled) throw new BadRequestException('Provider disabled');
    const discovery = await this.fetchDiscovery(provider);
    const state = crypto.randomBytes(16).toString('hex');
    stateStore.set(state, { providerId, expiresAt: Date.now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: provider.clientId!,
      redirect_uri: this.callbackUrl(providerId),
      response_type: 'code',
      scope: provider.scopes,
      state,
    });
    return `${discovery.authorization_endpoint}?${params}`;
  }

  async handleCallback(providerId: number, code: string, state: string) {
    const stored = stateStore.get(state);
    if (!stored || stored.providerId !== providerId || stored.expiresAt < Date.now()) {
      throw new UnauthorizedException('Invalid or expired state');
    }
    stateStore.delete(state);

    const provider = await this.getProvider(providerId);
    const discovery = await this.fetchDiscovery(provider);

    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.callbackUrl(providerId),
        client_id: provider.clientId!,
        client_secret: provider.clientSecret!,
      }),
    });
    if (!tokenRes.ok) throw new BadRequestException('Token exchange failed');
    const tokens = await tokenRes.json();

    const userInfoRes = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userInfoRes.ok) throw new BadRequestException('Userinfo fetch failed');
    const info = await userInfoRes.json();

    const user = await this.findOrCreateOidcUser(providerId, info.sub, info.email, info.name);
    const token = this.jwtService.sign({ sub: user.id, email: user.email, role: user.role });
    return { token, user };
  }

  async handleTelegram(providerId: number, data: Record<string, string>) {
    const provider = await this.getProvider(providerId);
    if (!provider.botToken) throw new BadRequestException('No bot token configured');

    const { hash, ...fields } = data;
    const checkString = Object.entries(fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHash('sha256').update(provider.botToken).digest();
    const expected = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
    if (expected !== hash) throw new UnauthorizedException('Telegram auth verification failed');

    const authDate = parseInt(fields.auth_date ?? '0', 10);
    if (Date.now() / 1000 - authDate > 86400) throw new UnauthorizedException('Telegram auth expired');

    const email = `tg_${fields.id}@telegram.local`;
    const user = await this.findOrCreateOidcUser(
      providerId,
      fields.id,
      email,
      `${fields.first_name ?? ''} ${fields.last_name ?? ''}`.trim() || fields.username,
    );
    const token = this.jwtService.sign({ sub: user.id, email: user.email, role: user.role });
    return { token, user: this.usersService.toDto(user) };
  }

  private async findOrCreateOidcUser(
    providerId: number,
    subject: string,
    email: string,
    displayName: string,
  ) {
    const { rows: existing } = await this.db.query<{ user_id: number }>(
      'SELECT user_id FROM user_idp_links WHERE provider_id = $1 AND subject = $2',
      [providerId, subject],
    );
    if (existing[0]) {
      const user = await this.usersService.findById(existing[0].user_id);
      if (!user) throw new UnauthorizedException('Linked user not found');
      return user;
    }
    // Try to find by email first
    let user = await this.usersService.findByEmail(email);
    if (!user) {
      const [first, ...rest] = (displayName ?? '').split(' ');
      const dto = await this.usersService.create({
        email,
        firstName: first ?? null,
        lastName: rest.join(' ') || null,
        role: 'viewer',
      });
      user = await this.usersService.findById(dto.id);
    }
    await this.db.query(
      'INSERT INTO user_idp_links (user_id, provider_id, subject) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [user!.id, providerId, subject],
    );
    return user!;
  }

  private async fetchDiscovery(provider: OidcProvider): Promise<DiscoveryDoc> {
    if (provider.authorizationEndpoint && provider.tokenEndpoint && provider.userinfoEndpoint) {
      return {
        authorization_endpoint: provider.authorizationEndpoint,
        token_endpoint: provider.tokenEndpoint,
        userinfo_endpoint: provider.userinfoEndpoint,
      };
    }
    if (!provider.discoveryUrl) throw new BadRequestException('No discovery URL or manual endpoints configured');
    const res = await fetch(provider.discoveryUrl);
    if (!res.ok) throw new BadRequestException('Failed to fetch OIDC discovery document');
    return res.json();
  }

  private callbackUrl(providerId: number): string {
    const base = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';
    return `${base}/api/auth/oidc/${providerId}/callback`;
  }

  private rowToProvider(r: any): OidcProvider {
    return {
      id: r.id, name: r.name, providerType: r.provider_type,
      isEnabled: r.is_enabled, clientId: r.client_id, clientSecret: r.client_secret,
      discoveryUrl: r.discovery_url, authorizationEndpoint: r.authorization_endpoint,
      tokenEndpoint: r.token_endpoint, userinfoEndpoint: r.userinfo_endpoint,
      scopes: r.scopes, botToken: r.bot_token, botUsername: r.bot_username,
      buttonText: r.button_text,
    };
  }
}
