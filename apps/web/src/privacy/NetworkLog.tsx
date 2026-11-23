import { useSyncExternalStore } from "react";
import { useI18n } from "../i18n";
import { networkLog, summarize } from "./networkLog";

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** "Network activity": every request this session, newest first. Says plainly when nothing left OverCut's own files. Fails soft. */
export function NetworkLog() {
  const { t } = useI18n();
  const events = useSyncExternalStore(networkLog.subscribe, networkLog.list);
  const own = location.host;
  const s = summarize(events, own);
  const quiet = s.outside.length === 0;
  return (
    <div data-testid="network-log">
      <p role="status" data-testid="network-summary" className={quiet ? undefined : "diag-bad"}>
        {quiet ? t("net.none") : t("net.outside", { hosts: s.outside.join(", ") })}
      </p>
      <p className="diag-muted">{t("net.count", { n: s.total, size: kb(s.bytes) })}</p>
      <div className="net-scroll" tabIndex={0} role="region" aria-label={t("net.title")}>
        <table className="net-table">
          <thead><tr><th scope="col">{t("net.col.time")}</th><th scope="col">{t("net.col.url")}</th><th scope="col">{t("net.col.size")}</th><th scope="col">{t("net.col.from")}</th></tr></thead>
          <tbody>
            {[...events].reverse().map((e) => (
              <tr key={e.id} data-initiator={e.initiator}>
                <td>{new Date(e.at).toLocaleTimeString()}</td>
                <td className="net-url">{e.url}</td>
                <td>{e.bytes === null ? "–" : kb(e.bytes)}</td>
                <td>{t(`net.from.${e.initiator}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
