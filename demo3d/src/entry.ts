/** Route selection only. The existing single-drone entry remains byte-identical. */
const q = new URLSearchParams(location.search);
if (q.get("mission") === "team") {
  await import("./team/app");
} else {
  await import("./main");
  const link = document.createElement("a");
  link.id = "team-entry";
  link.textContent = "Open three-drone mission";
  const url = new URL(location.href);
  url.searchParams.set("mission", "team");
  url.searchParams.set("fleet", "3");
  url.searchParams.set("teamarm", "coordinated");
  url.searchParams.set("t", "0");
  link.href = url.toString();
  link.style.cssText =
    "display:inline-block;color:#8ee8d0;margin:0 0 10px;text-decoration:underline";
  document.getElementById("ml-active")!.after(link);
}

export {};
