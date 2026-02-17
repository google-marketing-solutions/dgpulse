SELECT
  data_link.resource_name,
  data_link.status,
  data_link.type,
  data_link.youtube_video.video_id AS video_id
FROM data_link
WHERE data_link.type = 'VIDEO'
  AND data_link.status = 'ENABLED'
