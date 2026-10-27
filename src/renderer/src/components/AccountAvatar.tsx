import { useEffect, useRef, useState } from 'react'
import { IconUser } from './Icons'

/**
 * 账号头像 <img>：带「6 秒看门狗 + 阶梯重试」。
 * 账号头像请求偶发会挂起（既无 load 也无 error，一直 complete:false），
 * 直接用 <img> 会卡成破图；看门狗超时换 key 强制重挂重载一轮，
 * 两轮都失败则退回占位图标（不留破图）。
 */
export default function AccountAvatar({
  src,
  size = 22,
  className
}: {
  src?: string
  size?: number
  className?: string
}): JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const ref = useRef<HTMLImageElement>(null)

  useEffect(() => {
    if (!src || attempt > 1) return
    const timer = window.setTimeout(() => {
      const element = ref.current
      if (element && !element.complete) setAttempt((value) => value + 1)
    }, 6000)
    return () => window.clearTimeout(timer)
  }, [src, attempt])

  if (!src || attempt > 1) return <IconUser size={size} />

  // 第二轮重试用「去掉 ?v= 的原始地址」（部分代理对 query 处理异常）。
  const url = attempt === 0 ? src : src.replace(/[?&]v=\d+/g, '').replace(/\?$/, '')
  return (
    <img
      key={`${attempt}-${url}`}
      ref={ref}
      src={url}
      className={className}
      alt=""
      onError={() => setAttempt((value) => value + 1)}
    />
  )
}
