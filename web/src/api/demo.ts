// URL に ?demo を付けると、サーバーのデータではなく mock.ts のダミーデータを出す（説明用のスクリーンショットを撮るため）
export const isDemo = new URLSearchParams(location.search).has('demo');
