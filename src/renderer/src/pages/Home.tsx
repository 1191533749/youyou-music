/**
 * 首页（内容首页排布）。
 *
 * 从上到下依次是：问候语、今日热歌（播放全部 + 封面网格）、
 * 猜你喜欢或推荐歌单、排行榜（横滑卡片，带前三预览）、热门歌手（圆形头像横滑）、
 * 精品歌单。
 *
 * 四个板块各用一条通道（`home:hotSongs` / `home:feed` / `explore:topArtists` /
 * `explore:highQuality`），各自带 loading、错误重试与空态 —— 一条挂了不会让整页
 * 跟着白掉。调用一律走 contract 里的 call()，渲染进程不碰网络。
 */
import { useMemo, type ReactNode } from 'react'
import {
  ArtCard,
  call,
  coverUrl,
  formatDuration,
  formatPlayCount,
  useAuthStore,
  useNavigation,
  usePlayerStore
} from '../lib/contract'
import { useAsync } from '../lib/hooks'
import {
  IconCalendar,
  IconDiamond,
  IconDisc,
  IconLayers,
  IconMusic,
  IconPlay,
  IconUser
} from '../components/Icons'
import type { HomeFeedDTO, ToplistDTO } from '@shared/ipc'
import type { ArtistSummaryDTO, PlaylistSummaryDTO, TrackDTO } from '@shared/types'

/** 图标组件的公共形状：尺寸与类名可传，颜色跟随 currentColor。 */
type IconComponent = (props: { size?: number; className?: string }) => JSX.Element

/** 精品歌单板块一次取的数量。 */
const QUALITY_LIMIT = 12
/** 热门歌手一排取的数量。 */
const ARTIST_LIMIT = 14

export default function Home(): JSX.Element {
  const navigation = useNavigation()
  const player = usePlayerStore()
  const auth = useAuthStore()

  // 每块各自取数：某一块失败只影响它自己，重试也只重试那一块。
  const feed = useAsync<HomeFeedDTO>(() => call('home:feed'), [])
  // 今日热歌：主进程从飙升榜 / 热歌榜 / 新歌榜随机洗牌取 12 首，每次进首页换一批；
  // 未登录返回空数组，所以这里沿用「登录后再请求」的写法，省一次无用的 IPC。
  const hot = useAsync<TrackDTO[]>(
    () => (auth.loggedIn ? call('home:hotSongs') : Promise.resolve([])),
    [auth.loggedIn]
  )
  const artists = useAsync<ArtistSummaryDTO[]>(
    () => call('explore:topArtists', { limit: ARTIST_LIMIT }),
    []
  )
  const quality = useAsync<PlaylistSummaryDTO[]>(
    () =>
      call('explore:highQuality', { category: '全部', limit: QUALITY_LIMIT }).then(
        (page) => page.items
      ),
    []
  )

  const feedData = feed.data
  // 未登录时 recommendResource 为空，personalizedPlaylists 是不需要账号的公共推荐。
  const recommend = useMemo(() => {
    if (!feedData) return []
    return feedData.recommendPlaylists.length > 0
      ? feedData.recommendPlaylists
      : feedData.personalizedPlaylists
  }, [feedData])

  const hotSongs = hot.data ?? []
  const nickname = auth.profile?.nickname
  const title = auth.loggedIn && nickname ? `${greeting()}，${nickname}` : '猜你喜欢'

  return (
    <div className="page home">
      <header className="page__header">
        <div>
          <h1 className="page__title">{title}</h1>
          <div className="page__subtitle">
            {auth.loggedIn ? '推荐每天更新' : '登录后可以拿到属于你的每日推荐'}
          </div>
        </div>
      </header>

      <section className="page__section">
        <SectionHeader
          icon={IconCalendar}
          title="今日热歌"
          hint="为你随机挑选的今日热歌"
          action={
            hotSongs.length > 0 ? (
              <button
                type="button"
                className="button section-action"
                onClick={() => void player.playTracks(hotSongs, 0, { randomStart: true })}
              >
                <IconPlay size={14} />
                播放全部
              </button>
            ) : null
          }
        />
        {!auth.loggedIn && !auth.loading ? (
          <div className="home-hint">
            <div className="home-hint__title">登录后就能看到每日推荐</div>
            <button
              type="button"
              className="button button--primary"
              onClick={() => navigation.push({ name: 'library' })}
            >
              去登录
            </button>
          </div>
        ) : (
          <SectionShell
            loading={auth.loading || hot.loading}
            error={hot.error}
            onRetry={hot.reload}
            isEmpty={hotSongs.length === 0}
            emptyMessage="每日推荐还没生成，过一会儿再来看看"
          >
            <div className="grid grid--playlists">
              {hotSongs.map((track, index) => (
                <ArtCard
                  key={`${track.id}-${index}`}
                  title={track.name}
                  subtitle={track.artists.map((artist) => artist.name).join(' / ')}
                  imageUrl={coverUrl(track.album.picUrl, 320)}
                  badge={formatDuration(track.durationMS / 1000)}
                  onClick={() => void player.playTracks(hotSongs, index)}
                />
              ))}
            </div>
          </SectionShell>
        )}
      </section>

      <section className="page__section">
        <SectionHeader
          icon={IconMusic}
          title={feedData && feedData.recommendPlaylists.length > 0 ? '推荐歌单' : '猜你喜欢'}
        />
        <SectionShell
          loading={feed.loading}
          error={feed.error}
          onRetry={feed.reload}
          isEmpty={recommend.length === 0}
          emptyMessage="暂时没有推荐歌单，稍后再试"
        >
          <div className="grid grid--playlists">
            {recommend.map((playlist) => (
              <PlaylistCard
                key={playlist.id}
                playlist={playlist}
                onOpen={() =>
                  navigation.push({ name: 'playlist', id: playlist.id, title: playlist.name })
                }
              />
            ))}
          </div>
        </SectionShell>
      </section>

      <section className="page__section">
        <SectionHeader icon={IconLayers} title="排行榜" />
        <SectionShell
          loading={feed.loading}
          error={feed.error}
          onRetry={feed.reload}
          isEmpty={(feedData?.toplists.length ?? 0) === 0}
          emptyMessage="暂时拿不到排行榜"
        >
          <div className="home-rail">
            {(feedData?.toplists ?? []).slice(0, 12).map((toplist) => (
              <ToplistCard
                key={toplist.id}
                toplist={toplist}
                onOpen={() =>
                  navigation.push({ name: 'toplist', id: toplist.id, title: toplist.name })
                }
              />
            ))}
          </div>
        </SectionShell>
      </section>

      <section className="page__section">
        <SectionHeader icon={IconUser} title="热门歌手" />
        <SectionShell
          loading={artists.loading}
          error={artists.error}
          onRetry={artists.reload}
          isEmpty={(artists.data?.length ?? 0) === 0}
          emptyMessage="暂时没有热门歌手"
        >
          <div className="home-rail home-rail--artists">
            {/* 接口对 limit 不敏感（会一次返回 100 位），按自己声明的数量截断，别白渲染 DOM。 */}
            {(artists.data ?? []).slice(0, ARTIST_LIMIT).map((artist) => (
              <ArtCard
                key={artist.id}
                title={artist.name}
                subtitle={`${artist.musicSize} 首`}
                imageUrl={coverUrl(artist.picUrl, 240)}
                round
                onClick={() => navigation.push({ name: 'artist', id: artist.id, title: artist.name })}
              />
            ))}
          </div>
        </SectionShell>
      </section>

      <section className="page__section">
        <SectionHeader icon={IconDiamond} title="精品歌单" />
        <SectionShell
          loading={quality.loading}
          error={quality.error}
          onRetry={quality.reload}
          isEmpty={(quality.data?.length ?? 0) === 0}
          emptyMessage="暂时没有精品歌单"
        >
          <div className="grid grid--playlists">
            {(quality.data ?? []).map((playlist) => (
              <PlaylistCard
                key={playlist.id}
                playlist={playlist}
                onOpen={() =>
                  navigation.push({ name: 'playlist', id: playlist.id, title: playlist.name })
                }
              />
            ))}
          </div>
        </SectionShell>
      </section>
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  hint,
  action
}: {
  icon: IconComponent
  title: string
  hint?: ReactNode
  /** 右侧操作（整表播放等）；给了就不再显示 hint。 */
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="section__header">
      <h2 className="section__title">
        <Icon size={16} className="section__icon" />
        {title}
      </h2>
      {action ?? (hint ? <span className="section__more">{hint}</span> : null)}
    </div>
  )
}

/**
 * 板块的三态外壳：加载中转圈、失败给重试、空给文案，其余情况渲染内容。
 * 四个板块共用，避免每个板块各写一遍三态。
 */
function SectionShell({
  loading,
  error,
  onRetry,
  isEmpty,
  emptyMessage,
  children
}: {
  loading: boolean
  error?: string
  onRetry: () => void
  isEmpty: boolean
  emptyMessage: string
  children: ReactNode
}): JSX.Element {
  if (loading) {
    return (
      <div className="home-state">
        <IconDisc size={16} className="spin" />
        <span>正在加载…</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="page__error home__error">
        <span>{error}</span>
        <button type="button" className="button" onClick={onRetry}>
          重试
        </button>
      </div>
    )
  }
  if (isEmpty) {
    return <div className="home-empty">{emptyMessage}</div>
  }
  return <>{children}</>
}

function PlaylistCard({
  playlist,
  onOpen
}: {
  playlist: PlaylistSummaryDTO
  onOpen: () => void
}): JSX.Element {
  return (
    <ArtCard
      title={playlist.name}
      subtitle={playlist.creator?.nickname ?? `${playlist.trackCount} 首`}
      imageUrl={coverUrl(playlist.coverURL, 320)}
      badge={playlist.playCount > 0 ? formatPlayCount(playlist.playCount) : undefined}
      onClick={onOpen}
    />
  )
}

/**
 * 榜单卡片带前三首预览：歌单页要另开一次详情请求，预览能让用户不必点进去
 * 就知道榜单是不是自己想听的。
 */
function ToplistCard({ toplist, onOpen }: { toplist: ToplistDTO; onOpen: () => void }): JSX.Element {
  return (
    <button type="button" className="card home-toplist" onClick={onOpen} title={toplist.name}>
      <div className="card__art">
        {coverUrl(toplist.coverImgUrl, 320) ? (
          <img src={coverUrl(toplist.coverImgUrl, 320)} alt="" loading="lazy" />
        ) : (
          <span className="card__placeholder">
            <IconLayers size={26} />
          </span>
        )}
        {toplist.playCount > 0 ? (
          <span className="card__badge">{formatPlayCount(toplist.playCount)}</span>
        ) : null}
      </div>
      <div className="card__title">{toplist.name}</div>
      <div className="card__meta">{toplist.updateFrequency ?? '定期更新'}</div>
      {toplist.previews.length > 0 ? (
        <ol className="home-toplist__previews">
          {toplist.previews.slice(0, 3).map((preview, index) => (
            <li key={`${preview.first}-${index}`}>
              <span className="home-toplist__rank">{index + 1}</span>
              <span className="home-toplist__song">{preview.first}</span>
              <span className="home-toplist__artist">{preview.second}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </button>
  )
}

/** 早中晚的问候语 —— 桌面端的首页第一眼应该像「今天」。 */
function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}
