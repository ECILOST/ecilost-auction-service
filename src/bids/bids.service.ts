import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { WalletHoldClient } from '../events/wallet-hold.client.js';
@Injectable()
export class BidsService {
  constructor(private readonly prisma: PrismaService, private readonly wallet: WalletHoldClient) {}
  async place(roundId: string, bidderId: string, amount: number) {
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Bid amount must be positive.');
    const round = await this.prisma.round.findUnique({ where: { id: roundId }, include: { bids: { orderBy: { amount: 'desc' }, take: 1 } } });
    if (!round) throw new NotFoundException('Round does not exist.');
    if (round.status !== 'ACTIVE') throw new ConflictException('Round is not active.');
    const previousLeader = round.bids[0];
    if (previousLeader && amount <= Number(previousLeader.amount)) throw new ConflictException('Bid must improve the current bid.');
    const accepted = await this.wallet.hold(bidderId, `bid:${roundId}:${bidderId}`, amount);
    if (!accepted) throw new ConflictException('Insufficient available ECICoin.');
    const bid = await this.prisma.bid.upsert({ where: { roundId_bidderId: { roundId, bidderId } }, create: { id: crypto.randomUUID(), roundId, bidderId, amount }, update: { amount } });
    if (previousLeader && previousLeader.bidderId !== bidderId) {
      const released = await this.wallet.release(previousLeader.bidderId, `bid:${roundId}:${previousLeader.bidderId}`, Number(previousLeader.amount));
      if (!released) throw new ConflictException('The previous bid could not be released.');
    }
    return bid;
  }
}
