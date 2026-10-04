import * as React from "react"

// The persistent navigation rail begins at bp-lg. The query is in rem, like
// Tailwind's `lg:` that shows the sidebar, so JS and CSS agree at every
// default font size. Tablets share the phone drawer below it. The app renders
// on the client only, so matchMedia is safe in the initial state.
const MOBILE_QUERY = "(width < 64rem)"

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(
    () => window.matchMedia(MOBILE_QUERY).matches,
  )

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}

// bp-short: a landscape phone. Sheets come from the side and bars slim down.
const SHORT_QUERY = "(height < 31.25rem)"

export function useShortViewport() {
  const [short, setShort] = React.useState<boolean>(
    () =>
      typeof window !== "undefined" && window.matchMedia(SHORT_QUERY).matches,
  )

  React.useEffect(() => {
    const mql = window.matchMedia(SHORT_QUERY)
    const onChange = () => setShort(mql.matches)
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return short
}

// bp-md: the width a filter bar sits inline from. Below it, a phone.
const PHONE_QUERY = "(width < 48rem)"

export function useIsPhone() {
  // A server render (the pattern tests) has no window: inline, not a phone.
  const [phone, setPhone] = React.useState<boolean>(
    () =>
      typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches,
  )

  React.useEffect(() => {
    const mql = window.matchMedia(PHONE_QUERY)
    const onChange = () => setPhone(mql.matches)
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return phone
}
