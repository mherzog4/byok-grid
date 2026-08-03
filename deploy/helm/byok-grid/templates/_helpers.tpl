{{- define "byok-grid.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "byok-grid.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "byok-grid.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "byok-grid.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "byok-grid.labels" -}}
helm.sh/chart: {{ include "byok-grid.chart" . }}
app.kubernetes.io/name: {{ include "byok-grid.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "byok-grid.selectorLabels" -}}
app.kubernetes.io/name: {{ include "byok-grid.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "byok-grid.image" -}}
{{- $root := index . 0 -}}
{{- $component := index . 1 -}}
{{- $image := (index $root.Values $component).image -}}
{{- printf "%s:%s" $image.repository ($image.tag | default $root.Chart.AppVersion) -}}
{{- end }}

{{- define "byok-grid.secretName" -}}
{{- if .Values.secrets.create -}}
{{- printf "%s-secrets" (include "byok-grid.fullname" .) -}}
{{- else -}}
{{- required "secrets.existingSecret is required when secrets.create=false" .Values.secrets.existingSecret -}}
{{- end -}}
{{- end }}

{{- define "byok-grid.serviceAccountName" -}}
{{- $root := index . 0 -}}
{{- $component := index . 1 -}}
{{- $key := printf "%sName" $component -}}
{{- if $root.Values.serviceAccount.create -}}
{{- printf "%s-%s" (include "byok-grid.fullname" $root) ($component | kebabcase) | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- required (printf "serviceAccount.%s must be set when serviceAccount.create=false" $key) (index $root.Values.serviceAccount $key) -}}
{{- end -}}
{{- end }}
