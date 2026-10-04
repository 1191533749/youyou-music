/**
 * 排行榜详情.
 *
 * A toplist is a playlist server-side: `/v6/playlist/detail` answers for榜单 ids
 * too, which is why this page is a thin delegate rather than a second
 * implementation of the same hero + track list. The `kicker` tells the shared
 * page which heading to show.
 */
import PlaylistPage from './PlaylistPage'

export default function ToplistPage({ id }: { id: number }): JSX.Element {
  return <PlaylistPage id={id} kicker="排行榜" />
}
