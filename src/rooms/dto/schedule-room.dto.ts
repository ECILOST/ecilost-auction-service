import { Type } from 'class-transformer';
import { ArrayMinSize, IsDateString, IsEnum, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';

export enum AuctionableKindDto { ITEM = 'ITEM', LOT = 'LOT' }

export class RoundEntryDto {
  @IsEnum(AuctionableKindDto) kind: AuctionableKindDto;
  @IsUUID() catalogId: string;
}

export class RoundDto {
  @ArrayMinSize(1, { message: 'Cada ronda debe contener al menos un objeto o lote.' })
  @ValidateNested({ each: true }) @Type(() => RoundEntryDto) entries: RoundEntryDto[];
}

export class ScheduleRoomDto {
  @IsInt() @Min(1, { message: 'El aforo maximo debe ser mayor que cero.' }) maximumCapacity: number;
  @IsDateString() startsAt: string;
  @ArrayMinSize(1, { message: 'La sala debe tener al menos una ronda.' })
  @ValidateNested({ each: true }) @Type(() => RoundDto) rounds: RoundDto[];
}
