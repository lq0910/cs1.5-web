/** 功能：单机与房主共用购买、装备切换及购买结果，避免联机购买只有请求没有反馈；时间：2026-11-18；作者：lq。 */
import type { Actor } from '../game/actors.ts';
import type { Match } from '../game/match.ts';
import { BUY_MENU } from '../game/gamemode.ts';
import type { PlayerActions, PurchaseResult } from './protocol.ts';

export function purchaseEquipment(match: Match, actor: Actor, itemId: string, now: number): PurchaseResult {
  const failure = match.mode.buyFailure(actor, itemId);
  if (failure) return { kind: 'buy', item: itemId, success: false, message: failure };
  const item = BUY_MENU.find((entry) => entry.id === itemId)!;
  match.mode.buy(actor, itemId);
  actor.selectedBomb = false;
  if (item.slot) { actor.selectedGrenade = null; actor.combat.selectSlot(item.slot, now); }
  if (item.grenade) actor.selectedGrenade = item.grenade;
  return { kind: 'buy', item: itemId, success: true, message: `已购买 ${item.label}` };
}

/** 功能：主副武器补弹返回成功或失败说明，满弹药不会再次扣费；时间：2026-11-18；作者：lq。 */
export function purchaseAmmo(match: Match, actor: Actor, slot: 1 | 2): PurchaseResult {
  const success = match.mode.buyAmmo(actor, slot);
  return { kind: 'ammo', item: String(slot), success,
    message: success ? '备用弹药已补充' : !actor.alive ? '已阵亡，请等待下一回合再购买'
      : match.mode.phase === 'over' || match.mode.matchOver ? '回合已结束，请等待下一回合再购买'
        : actor.combat.loadout[slot].id === 'knife' ? '该栏位没有枪械'
          : actor.money < (slot === 1 ? 60 : 20) && !actor.unlimitedFunds ? '资金不足，无法购买弹药' : '备用弹药已满' };
}

/** 功能：房主每 tick 执行一次玩家操作，购买失败后仍返回结果且不影响后续输入；时间：2026-11-18；作者：lq。 */
export function applyPlayerActions(match: Match, actor: Actor, actions: PlayerActions, now: number): PurchaseResult[] {
  const results: PurchaseResult[] = [];
  if (actions.buy) results.push(purchaseEquipment(match, actor, actions.buy, now));
  if (actions.ammo) results.push(purchaseAmmo(match, actor, actions.ammo));
  if (!actor.alive) return results;
  if (actions.slot) { actor.selectedBomb = false; actor.selectedGrenade = null; actor.combat.selectSlot(actions.slot, now); }
  if (actions.grenade && actor.grenades[actions.grenade] > 0) {
    actor.selectedBomb = false; actor.selectedGrenade = actions.grenade;
  }
  if (actions.bomb !== undefined) { actor.selectedBomb = actions.bomb; actor.selectedGrenade = null; }
  if (actions.drop) match.dropCurrentWeapon(actor, now);
  if (actions.pickup) match.pickupNearestWeapon(actor, now);
  return results;
}
