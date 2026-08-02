import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { OidcService } from './oidc.service';
import { Public } from '../auth/guards/public.decorator';
import { Permission } from '../auth/guards/permission.decorator';
import { CreateOidcProviderDto, UpdateOidcProviderDto } from './dto/oidc-provider.dto';

@Controller('oidc')
export class OidcController {
  constructor(private readonly oidcService: OidcService) {}

  // Public, unauthenticated route — the login page calls this before the
  // user has a session. Returns only the fields the login page needs; the
  // full record (client secrets, bot tokens included) is only ever returned
  // from the admin routes below, which require oidc:write.
  @Get('providers')
  @Public()
  listProviders() {
    return this.oidcService.listPublicProviders();
  }

  @Get('providers/admin')
  @Permission('oidc', 'write')
  listProvidersAdmin() {
    return this.oidcService.listProviders();
  }

  @Post('providers')
  @Permission('oidc', 'write')
  createProvider(@Body() body: CreateOidcProviderDto) {
    return this.oidcService.createProvider(body);
  }

  @Put('providers/:id')
  @Permission('oidc', 'write')
  updateProvider(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateOidcProviderDto) {
    return this.oidcService.updateProvider(id, body);
  }

  @Delete('providers/:id')
  @Permission('oidc', 'delete')
  deleteProvider(@Param('id', ParseIntPipe) id: number) {
    return this.oidcService.deleteProvider(id);
  }
}
