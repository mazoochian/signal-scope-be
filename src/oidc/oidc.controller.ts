import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { OidcService } from './oidc.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/guards/roles.decorator';

@Controller('oidc')
export class OidcController {
  constructor(private readonly oidcService: OidcService) {}

  @Get('providers')
  listProviders() {
    // Public: frontend needs provider list for login page
    return this.oidcService.listProviders();
  }

  @Post('providers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  createProvider(@Body() body: any) {
    return this.oidcService.createProvider(body);
  }

  @Put('providers/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  updateProvider(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.oidcService.updateProvider(id, body);
  }

  @Delete('providers/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  deleteProvider(@Param('id', ParseIntPipe) id: number) {
    return this.oidcService.deleteProvider(id);
  }
}
