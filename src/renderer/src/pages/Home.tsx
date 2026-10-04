/**
 * 首页。
 *
 * 五个板块由一次 `home:feed` 取齐，而不是每块各发一次请求：主进程在同一次
 * 调用里判定登录态，各板块才不会出现「有的已登录、有的还是游客」的错位。
 * 未登录时日推和推荐歌单本来就是空的（主进程直接返回空数组），这里用公共
 * 推荐兜底并给出去登录的入口，而不是留一片空白。
 */
import { useMemo, type ReactNode } from 'react'
import {
  ArtCard,
  SongList,
  artistLine,
  call,
  coverUrl,
  formatDate,
  formatDuration,
  formatPlayCount,
  useNavigation,
  usePlayerStore
} from '../lib/contract'
import { useAsync } from '../lib/hooks'
import type { HomeFeedDTO, ToplistDTO } from '@shared/ipc'

export default function Home(): JSX.Element {
  const navigation = useNavigation()
  const player = usePlayerStore()
  const feed = useAsync<HomeFeedDTO>(() => call('home:feed'), [])
  const data = feed.data

  // 未登录时 recommendResource 返回空，personalizedPlaylists 是无需登录的
  // 公共推荐 —— 两者合并成同一个「推荐歌单」板块，界面不会空一块。
  const recommend = useMemo(() => {
    if (!data) return []
    return data.recommendPlaylists.length > 0 ? data.recommendPlaylists : data.personalizedPlaylists
  }, [data])

  const publicFallback = !!data && data.recommendPlaylists.length === 0

  const empty =
    !!data &&
    data.dailySongs.length === 0 &&
    recommend.length === 0 &&
    data.radarPlaylists.length === 0 &&
    data.newSongs.length === 0 &&
    data.toplists.length === 0

  const currentTrackID = player.current?.id

  return (
    <div className="page home">
      <header className="page__header">
        <div>
          <h1 className="page__title">{greeting()}</h1>
          <div className="page__subtitle">今天想听点什么 · {formatDate(Date.now())}</div>
        </div>
      </header>

      {feed.error ? (
        <div className="page__error home__error">
          <span>首页加载失败：{feed.error}</span>
          <button type="button" className="button" onClick={feed.reload}>
            重试
          </button>
        </div>
      ) : null}

      {feed.loading ? (
        <div className="home-skeleton" aria-busy="true">
          <div className="page__subtitle">正在加载首页内容…</div>
          <div className="skeleton home-skeleton__row" />
          <div className="skeleton home-skeleton__row" />
          <div className="skeleton home-skeleton__row" />
        </div>
      ) : null}

      {!feed.loading && data && empty ? (
        <>
          <div className="placeholder">
            <div className="placeholder__title">
              {publicFallback ? '登录后即可查看推荐内容' : '暂时没有可展示的内容'}
            </div>
            <div>
              {publicFallback
                ? '每日推荐、雷达歌单和个性化推荐都需要账号；也可能是网络暂时不可用，可以点上方「重试」。'
                : '可以点上方「重试」重新获取，或者稍后再来。'}
            </div>
          </div>
          {publicFallback ? (
            <div className="home-hint">
              <div className="home-hint__title">还没有登录网易云账号</div>
              <div className="home-hint__body">扫码登录后，这里会换成你自己的每日推荐与雷达歌单。</div>
              <button
                type="button"
                className="button button--primary"
                onClick={() => navigation.push({ name: 'library' })}
              >
                去登录
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {!feed.loading && data && !empty ? (
        <>
          <section className="page__section">
            <SectionHeader title="每日推荐" hint="根据你的口味生成" />
            {data.dailySongs.length > 0 ? (
              <SongList
                tracks={data.dailySongs}
                currentTrackID={currentTrackID}
                onPlay={(index) => void player.playTracks(data.dailySongs, index)}
              />
            ) : (
              <div className="home-hint">
                <div className="home-hint__title">
                  {publicFallback ? '登录后即可查看每日推荐' : '今天的每日推荐还没准备好'}
                </div>
                <div className="home-hint__body">
                  {publicFallback
                    ? '每日推荐和雷达歌单登录后才有；如果已经登录，点上方「重试」重新获取。'
                    : '稍后点上方「重试」重新获取。'}
                </div>
                {publicFallback ? (
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => navigation.push({ name: 'library' })}
                  >
                    去登录
                  </button>
                ) : null}
              </div>
            )}
          </section>

          <section className="page__section">
            <SectionHeader
              title="推荐歌单"
              hint={publicFallback ? '未登录，展示公共推荐' : '为你精选'}
            />
            {recommend.length > 0 ? (
              <div className="grid grid--playlists">
                {recommend.map((playlist) => (
                  <ArtCard
                    key={playlist.id}
                    title={playlist.name}
                    subtitle={playlist.copywriter ?? playlist.creator?.nickname}
                    imageUrl={coverUrl(playlist.coverURL, 320)}
                    badge={playlist.playCount > 0 ? formatPlayCount(playlist.playCount) : undefined}
                    onClick={() =>
                      navigation.push({ name: 'playlist', id: playlist.id, title: playlist.name })
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="page__empty">暂时拿不到推荐歌单</div>
            )}
          </section>

          {data.radarPlaylists.length > 0 ? (
            <section className="page__section">
              <SectionHeader title="雷达歌单" hint="按你的收听口味每天更新" />
              <div className="grid grid--playlists">
                {data.radarPlaylists.map((playlist) => (
                  <ArtCard
                    key={playlist.id}
                    title={playlist.name}
                    subtitle="私人雷达"
                    imageUrl={coverUrl(playlist.coverURL, 320)}
                    onClick={() =>
                      navigation.push({ name: 'playlist', id: playlist.id, title: playlist.name })
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="page__section">
            <SectionHeader title="新歌速递" hint="点击封面即可播放" />
            {data.newSongs.length > 0 ? (
              <div className="grid grid--playlists">
                {data.newSongs.map((track, index) => (
                  <ArtCard
                    key={`${track.id}-${index}`}
                    title={track.name}
                    subtitle={artistLine(track)}
                    imageUrl={coverUrl(track.album.picUrl, 240)}
                    badge={formatDuration(track.durationMS / 1000)}
                    onClick={() => void player.playTracks(data.newSongs, index)}
                  />
                ))}
              </div>
            ) : (
              <div className="page__empty">暂时没有新歌</div>
            )}
          </section>

          <section className="page__section">
            <SectionHeader title="排行榜" hint={data.toplists.length > 0 ? `共 ${data.toplists.length} 个榜单` : undefined} />
            {data.toplists.length > 0 ? (
              <div className="grid grid--albums">
                {data.toplists.slice(0, 8).map((toplist) => (
                  <ToplistCard
                    key={toplist.id}
                    toplist={toplist}
                    onOpen={() =>
                      navigation.push({ name: 'toplist', id: toplist.id, title: toplist.name })
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="page__empty">暂时拿不到排行榜</div>
            )}
          </section>
        </>
      ) : null}
    </div>
  )
}

function SectionHeader({
  title,
  hint
}: {
  title: string
  hint?: ReactNode
}): JSX.Element {
  return (
    <div className="section__header">
      <h2 className="section__title">{title}</h2>
      {hint ? <span className="section__more">{hint}</span> : null}
    </div>
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
          <span className="card__placeholder">榜</span>
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
