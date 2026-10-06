/**
 * 礼物目录（服务端权威）。
 *
 * 价格单位：分。礼物分级从普通到稀有，供客户端展示与赠送扣费。
 */
export const GIFTS = [
  { id: 'heart', name: '心动', emoji: '❤', price: 100, tier: 'common' },
  { id: 'rose', name: '玫瑰', emoji: '🌹', price: 200, tier: 'common' },
  { id: 'beer', name: '干杯', emoji: '🍻', price: 500, tier: 'common' },
  { id: 'cake', name: '生日蛋糕', emoji: '🎂', price: 1000, tier: 'common' },
  { id: 'star', name: '星星', emoji: '⭐', price: 1500, tier: 'rare' },
  { id: 'music', name: '音符', emoji: '🎵', price: 2000, tier: 'rare' },
  { id: 'crown', name: '皇冠', emoji: '👑', price: 5200, tier: 'rare' },
  { id: 'rocket', name: '小火箭', emoji: '🚀', price: 9900, tier: 'epic' },
  { id: 'castle', name: '城堡', emoji: '🏰', price: 19900, tier: 'epic' },
  { id: 'galaxy', name: '银河', emoji: '🌌', price: 52000, tier: 'legend' }
]

export function findGift(id) {
  return GIFTS.find((gift) => gift.id === id)
}
