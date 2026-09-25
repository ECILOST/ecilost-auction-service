import { Transform, Type } from 'class-transformer';
import { ArrayMinSize, IsDateString, IsEnum, IsInt, IsNotEmpty, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';

export enum AuctionableKindDto { ITEM = 'ITEM', LOT = 'LOT' }

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class RoundEntryDto {
  @IsEnum(AuctionableKindDto) kind: AuctionableKindDto;
  @IsUUID() catalogId: string;
}

export class RoundDto {
  @ArrayMinSize(1, { message: 'Cada ronda debe contener al menos un objeto o lote.' })
  @ValidateNested({ each: true }) @Type(() => RoundEntryDto) entries: RoundEntryDto[];

  /** ECICoin vale lo mismo que el peso colombiano: el precio minimo es un entero positivo. */
  @IsInt({ message: 'El precio minimo debe ser un numero entero.' })
  @Min(1, { message: 'El precio minimo debe ser mayor que cero.' })
  startingPrice: number;
}

export class ScheduleRoomDto {
  @Transform(trim) @IsString() @IsNotEmpty({ message: 'La sala debe tener un nombre.' }) @MaxLength(80) name: string;
  @IsInt() @Min(1, { message: 'El aforo maximo debe ser mayor que cero.' }) maximumCapacity: number;
  @IsDateString() startsAt: string;
  @ArrayMinSize(1, { message: 'La sala debe tener al menos una ronda.' })
  @ValidateNested({ each: true }) @Type(() => RoundDto) rounds: RoundDto[];
}
