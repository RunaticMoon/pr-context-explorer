import React from "react";
export const settingsTabs = [
  { id: "github", label: "GitHub" },
  { id: "engine", label: "분석 엔진" },
  { id: "jira", label: "Jira" },
  { id: "updates", label: "업데이트" },
] as const;
export function SettingsTabs({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="연결 및 분석 설정"
      className="settings-tabs"
    >
      {settingsTabs.map((tab, index) => (
        <button
          key={tab.id}
          id={`settings-tab-${tab.id}`}
          role="tab"
          aria-selected={value === tab.id}
          aria-controls={`settings-panel-${tab.id}`}
          tabIndex={value === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? settingsTabs.length - 1
                  : event.key === "ArrowRight"
                    ? (index + 1) % settingsTabs.length
                    : event.key === "ArrowLeft"
                      ? (index + settingsTabs.length - 1) % settingsTabs.length
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            onChange(settingsTabs[next].id);
            document
              .getElementById(`settings-tab-${settingsTabs[next].id}`)
              ?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
