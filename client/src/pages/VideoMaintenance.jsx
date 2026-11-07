import { Link } from "react-router-dom";
export default function VideoMaintenance() {
  return <section className="mx-auto max-w-2xl p-8 text-center"><h1 className="mb-5 text-3xl font-bold">视频生成维护中</h1><p className="mb-4">视频生成接口暂时异常，已暂停新增视频生成，恢复后另行通知。</p><p className="mb-6">已有视频和历史记录保留，图片生成功能不在本次暂停范围内。</p><Link to="/ai/scene-image" className="underline">前往图片生成</Link></section>;
}
