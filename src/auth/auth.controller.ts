import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { OidcService } from '../oidc/oidc.service';
import { Public } from './guards/public.decorator';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly oidcService: OidcService,
  ) {
    if (!process.env.FRONTEND_URL) {
      this.logger.warn(
        'FRONTEND_URL is not set — post-OIDC-login redirects will fall back to ' +
          'http://localhost:3000, which is wrong for any non-local deployment. ' +
          'Set FRONTEND_URL to the public URL of the frontend.',
      );
    }
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @Body() body: { email: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, user } = await this.authService.login(body.email, body.password);
    this.authService.setTokenCookie(res, token);
    return { user };
  }

  @Post('logout')
  @Public()
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    this.authService.clearTokenCookie(res);
    return { ok: true };
  }

  @Get('me')
  me(@Req() req: Request) {
    return (req as any).user;
  }

  @Get('oidc/:providerId/authorize')
  @Public()
  async oidcAuthorize(
    @Param('providerId') providerId: string,
    @Res() res: Response,
  ) {
    const url = await this.oidcService.buildAuthorizationUrl(Number(providerId));
    return res.redirect(url);
  }

  @Get('oidc/:providerId/callback')
  @Public()
  async oidcCallback(
    @Param('providerId') providerId: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const { token } = await this.oidcService.handleCallback(
      Number(providerId),
      code,
      state,
    );
    this.authService.setTokenCookie(res, token);
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    return res.redirect(frontendUrl);
  }

  @Post('telegram/:providerId')
  @Public()
  @HttpCode(200)
  async telegramAuth(
    @Param('providerId') providerId: string,
    @Body() data: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, user } = await this.oidcService.handleTelegram(
      Number(providerId),
      data,
    );
    this.authService.setTokenCookie(res, token);
    return { user };
  }
}
