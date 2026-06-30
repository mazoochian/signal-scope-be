import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { OidcService } from './oidc.service';
import { Public } from '../auth/guards/public.decorator';
import { Permission } from '../auth/guards/permission.decorator';

@Controller('oidc')
export class OidcController {
  constructor(private readonly oidcService: OidcService) {}

  @Get('providers')
  @Public()
  listProviders() {
    return this.oidcService.listProviders();
  }

  @Post('providers')
  @Permission('oidc', 'write')
  createProvider(@Body() body: any) {
    return this.oidcService.createProvider(body);
  }

  @Put('providers/:id')
  @Permission('oidc', 'write')
  updateProvider(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.oidcService.updateProvider(id, body);
  }

  @Delete('providers/:id')
  @Permission('oidc', 'delete')
  deleteProvider(@Param('id', ParseIntPipe) id: number) {
    return this.oidcService.deleteProvider(id);
  }
}
