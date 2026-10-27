// 中继身份：悠悠账号优先（uid=yy-<id>），网易云账号只作兜底与资料增强。
// App 外壳与一起听页面共用同一套计算，避免两处漂移。
export interface RelayIdentitySource {
  loggedIn: boolean
  profile?: { userId?: number | string; nickname?: string; avatarUrl?: string } | null
}
export interface RelayIdentityAccount {
  loggedIn: boolean
  profile?: { id?: number; nickname?: string; avatar?: string } | null
}
export interface RelayIdentity {
  signedIn: boolean
  uid: string | undefined
  nickname: string | undefined
  avatar: string | undefined
}
export function relayIdentity(auth: RelayIdentitySource, account: RelayIdentityAccount): RelayIdentity {
  const signedIn = auth.loggedIn || account.loggedIn
  const uid = account.profile
    ? `yy-${account.profile.id}`
    : auth.profile?.userId != null
      ? String(auth.profile.userId)
      : undefined
  const nickname = account.profile?.nickname ?? auth.profile?.nickname
  const avatar = account.profile?.avatar ?? auth.profile?.avatarUrl
  return { signedIn, uid, nickname, avatar }
}
