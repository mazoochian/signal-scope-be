import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OidcService } from '../oidc/oidc.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly oidcService: OidcService,
  ) {}

  @Post('login')
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
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    this.authService.clearTokenCookie(res);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: Request) {
    return (req as any).user;
  }

  @Get('oidc/:providerId/authorize')
  async oidcAuthorize(
    @Param('providerId') providerId: string,
    @Res() res: Response,
  ) {
    const url = await this.oidcService.buildAuthorizationUrl(Number(providerId));
    return res.redirect(url);
  }

  @Get('oidc/:providerId/callback')
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
