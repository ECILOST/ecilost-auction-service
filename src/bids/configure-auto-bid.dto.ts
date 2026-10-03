import { IsBoolean, IsInt, IsOptional, IsPositive, ValidateIf } from 'class-validator';

/** HU-22. ECICoin no tiene fracciones: el limite es un entero. Desactivar no necesita limite. */
export class ConfigureAutoBidDto {
  @IsBoolean() enabled: boolean;
  @ValidateIf((dto: ConfigureAutoBidDto) => dto.enabled)
  @IsInt({ message: 'El limite maximo debe ser un numero entero.' })
  @IsPositive({ message: 'El limite maximo debe ser mayor que cero.' })
  @IsOptional()
  maximumAmount?: number;
}
