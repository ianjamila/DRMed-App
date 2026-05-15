export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      accounting_periods: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          created_at: string
          fiscal_month: number
          fiscal_quarter: number
          fiscal_year: number
          id: string
          notes: string | null
          period_end: string
          period_start: string
          status: Database["public"]["Enums"]["period_status"]
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          fiscal_month: number
          fiscal_quarter: number
          fiscal_year: number
          id?: string
          notes?: string | null
          period_end: string
          period_start: string
          status?: Database["public"]["Enums"]["period_status"]
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          fiscal_month?: number
          fiscal_quarter?: number
          fiscal_year?: number
          id?: string
          notes?: string | null
          period_end?: string
          period_start?: string
          status?: Database["public"]["Enums"]["period_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounting_periods_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          booking_group_id: string | null
          created_at: string
          created_by: string | null
          home_service_requested: boolean
          id: string
          notes: string | null
          patient_id: string | null
          physician_id: string | null
          scheduled_at: string | null
          service_id: string | null
          status: string
          walk_in_name: string | null
          walk_in_phone: string | null
        }
        Insert: {
          booking_group_id?: string | null
          created_at?: string
          created_by?: string | null
          home_service_requested?: boolean
          id?: string
          notes?: string | null
          patient_id?: string | null
          physician_id?: string | null
          scheduled_at?: string | null
          service_id?: string | null
          status?: string
          walk_in_name?: string | null
          walk_in_phone?: string | null
        }
        Update: {
          booking_group_id?: string | null
          created_at?: string
          created_by?: string | null
          home_service_requested?: boolean
          id?: string
          notes?: string | null
          patient_id?: string | null
          physician_id?: string | null
          scheduled_at?: string | null
          service_id?: string | null
          status?: string
          walk_in_name?: string | null
          walk_in_phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "appointments_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_physician_id_fkey"
            columns: ["physician_id"]
            isOneToOne: false
            referencedRelation: "physicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: string
          created_at: string
          id: number
          ip_address: unknown
          metadata: Json | null
          patient_id: string | null
          resource_id: string | null
          resource_type: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type: string
          created_at?: string
          id?: number
          ip_address?: unknown
          metadata?: Json | null
          patient_id?: string | null
          resource_id?: string | null
          resource_type?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          id?: number
          ip_address?: unknown
          metadata?: Json | null
          patient_id?: string | null
          resource_id?: string | null
          resource_type?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      chart_of_accounts: {
        Row: {
          code: string
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          normal_balance: Database["public"]["Enums"]["account_normal_balance"]
          parent_id: string | null
          type: Database["public"]["Enums"]["account_type"]
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          normal_balance: Database["public"]["Enums"]["account_normal_balance"]
          parent_id?: string | null
          type: Database["public"]["Enums"]["account_type"]
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          normal_balance?: Database["public"]["Enums"]["account_normal_balance"]
          parent_id?: string | null
          type?: Database["public"]["Enums"]["account_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chart_of_accounts_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "chart_of_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      clinic_closures: {
        Row: {
          closed_on: string
          created_at: string
          created_by: string | null
          reason: string
        }
        Insert: {
          closed_on: string
          created_at?: string
          created_by?: string | null
          reason: string
        }
        Update: {
          closed_on?: string
          created_at?: string
          created_by?: string | null
          reason?: string
        }
        Relationships: []
      }
      contact_messages: {
        Row: {
          created_at: string
          email: string | null
          handled: boolean
          handled_at: string | null
          handled_by: string | null
          id: string
          ip_address: unknown
          message: string
          name: string
          phone: string | null
          subject: string | null
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          handled?: boolean
          handled_at?: string | null
          handled_by?: string | null
          id?: string
          ip_address?: unknown
          message: string
          name: string
          phone?: string | null
          subject?: string | null
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          handled?: boolean
          handled_at?: string | null
          handled_by?: string | null
          id?: string
          ip_address?: unknown
          message?: string
          name?: string
          phone?: string | null
          subject?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      critical_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          direction: string
          id: string
          observed_value_si: number | null
          parameter_id: string
          parameter_name: string
          patient_drm_id: string | null
          patient_id: string | null
          result_id: string
          test_request_id: string
          threshold_si: number | null
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          direction: string
          id?: string
          observed_value_si?: number | null
          parameter_id: string
          parameter_name: string
          patient_drm_id?: string | null
          patient_id?: string | null
          result_id: string
          test_request_id: string
          threshold_si?: number | null
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          direction?: string
          id?: string
          observed_value_si?: number | null
          parameter_id?: string
          parameter_name?: string
          patient_drm_id?: string | null
          patient_id?: string | null
          result_id?: string
          test_request_id?: string
          threshold_si?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "critical_alerts_parameter_id_fkey"
            columns: ["parameter_id"]
            isOneToOne: false
            referencedRelation: "result_template_params"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "critical_alerts_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "critical_alerts_result_id_fkey"
            columns: ["result_id"]
            isOneToOne: false
            referencedRelation: "results"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "critical_alerts_test_request_id_fkey"
            columns: ["test_request_id"]
            isOneToOne: false
            referencedRelation: "test_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "critical_alerts_test_request_id_fkey"
            columns: ["test_request_id"]
            isOneToOne: false
            referencedRelation: "v_hmo_unbilled"
            referencedColumns: ["test_request_id"]
          },
        ]
      }
      gift_codes: {
        Row: {
          batch_label: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          code: string
          created_at: string
          face_value_php: number
          generated_at: string
          generated_by: string | null
          id: string
          notes: string | null
          purchase_method: string | null
          purchase_reference_number: string | null
          purchased_at: string | null
          purchased_by_contact: string | null
          purchased_by_name: string | null
          redeemed_at: string | null
          redeemed_by: string | null
          redeemed_payment_id: string | null
          redeemed_visit_id: string | null
          sold_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          batch_label?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          code: string
          created_at?: string
          face_value_php: number
          generated_at?: string
          generated_by?: string | null
          id?: string
          notes?: string | null
          purchase_method?: string | null
          purchase_reference_number?: string | null
          purchased_at?: string | null
          purchased_by_contact?: string | null
          purchased_by_name?: string | null
          redeemed_at?: string | null
          redeemed_by?: string | null
          redeemed_payment_id?: string | null
          redeemed_visit_id?: string | null
          sold_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          batch_label?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          code?: string
          created_at?: string
          face_value_php?: number
          generated_at?: string
          generated_by?: string | null
          id?: string
          notes?: string | null
          purchase_method?: string | null
          purchase_reference_number?: string | null
          purchased_at?: string | null
          purchased_by_contact?: string | null
          purchased_by_name?: string | null
          redeemed_at?: string | null
          redeemed_by?: string | null
          redeemed_payment_id?: string | null
          redeemed_visit_id?: string | null
          sold_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gift_codes_redeemed_payment_id_fkey"
            columns: ["redeemed_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gift_codes_redeemed_payment_id_fkey"
            columns: ["redeemed_payment_id"]
            isOneToOne: false
            referencedRelation: "v_historical_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gift_codes_redeemed_visit_id_fkey"
            columns: ["redeemed_visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      hmo_claim_batches: {
        Row: {
          created_at: string
          historical_source: string | null
          hmo_ack_ref: string | null
          id: string
          import_run_id: string | null
          medium: string | null
          notes: string | null
          provider_id: string
          reference_no: string | null
          status: string
          submitted_at: string | null
          submitted_by: string | null
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          created_at?: string
          historical_source?: string | null
          hmo_ack_ref?: string | null
          id?: string
          import_run_id?: string | null
          medium?: string | null
          notes?: string | null
          provider_id: string
          reference_no?: string | null
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          created_at?: string
          historical_source?: string | null
          hmo_ack_ref?: string | null
          id?: string
          import_run_id?: string | null
          medium?: string | null
          notes?: string | null
          provider_id?: string
          reference_no?: string | null
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hmo_claim_batches_import_run_id_fkey"
            columns: ["import_run_id"]
            isOneToOne: false
            referencedRelation: "hmo_import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_claim_batches_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "hmo_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_claim_batches_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "v_hmo_provider_summary"
            referencedColumns: ["provider_id"]
          },
          {
            foreignKeyName: "hmo_claim_batches_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_claim_batches_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      hmo_claim_items: {
        Row: {
          batch_id: string
          batch_voided: boolean
          billed_amount_php: number
          created_at: string
          hmo_approval_date: string | null
          hmo_response: string
          hmo_response_date: string | null
          hmo_response_notes: string | null
          id: string
          paid_amount_php: number
          patient_billed_amount_php: number
          test_request_id: string
          updated_at: string
          written_off_amount_php: number
        }
        Insert: {
          batch_id: string
          batch_voided?: boolean
          billed_amount_php: number
          created_at?: string
          hmo_approval_date?: string | null
          hmo_response?: string
          hmo_response_date?: string | null
          hmo_response_notes?: string | null
          id?: string
          paid_amount_php?: number
          patient_billed_amount_php?: number
          test_request_id: string
          updated_at?: string
          written_off_amount_php?: number
        }
        Update: {
          batch_id?: string
          batch_voided?: boolean
          billed_amount_php?: number
          created_at?: string
          hmo_approval_date?: string | null
          hmo_response?: string
          hmo_response_date?: string | null
          hmo_response_notes?: string | null
          id?: string
          paid_amount_php?: number
          patient_billed_amount_php?: number
          test_request_id?: string
          updated_at?: string
          written_off_amount_php?: number
        }
        Relationships: [
          {
            foreignKeyName: "hmo_claim_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "hmo_claim_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_claim_items_test_request_id_fkey"
            columns: ["test_request_id"]
            isOneToOne: false
            referencedRelation: "test_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_claim_items_test_request_id_fkey"
            columns: ["test_request_id"]
            isOneToOne: false
            referencedRelation: "v_hmo_unbilled"
            referencedColumns: ["test_request_id"]
          },
        ]
      }
      hmo_claim_resolutions: {
        Row: {
          amount_php: number
          destination: string
          id: string
          item_id: string
          notes: string | null
          resolved_at: string
          resolved_by: string | null
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount_php: number
          destination: string
          id?: string
          item_id: string
          notes?: string | null
          resolved_at?: string
          resolved_by?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount_php?: number
          destination?: string
          id?: string
          item_id?: string
          notes?: string | null
          resolved_at?: string
          resolved_by?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hmo_claim_resolutions_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "hmo_claim_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_claim_resolutions_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_hmo_stuck"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "hmo_claim_resolutions_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_claim_resolutions_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      hmo_history_staging: {
        Row: {
          billed_amount: number
          content_hash: string | null
          created_at: string
          first_name_raw: string
          hmo_approval_date: string | null
          id: string
          last_name_raw: string
          normalized_patient_name: string
          or_number: string | null
          paid_amount: number
          patient_name_raw: string
          payment_received_date: string | null
          provider_id_resolved: string | null
          provider_name_raw: string
          reference_no: string | null
          run_id: string
          senior_pwd_flag: boolean
          service_id_resolved: string | null
          service_name_raw: string
          source_date: string
          source_row_no: number
          source_tab: string
          status: string
          submission_date: string | null
          validation_errors: Json
          visit_group_key: string | null
        }
        Insert: {
          billed_amount: number
          content_hash?: string | null
          created_at?: string
          first_name_raw: string
          hmo_approval_date?: string | null
          id?: string
          last_name_raw: string
          normalized_patient_name: string
          or_number?: string | null
          paid_amount?: number
          patient_name_raw: string
          payment_received_date?: string | null
          provider_id_resolved?: string | null
          provider_name_raw: string
          reference_no?: string | null
          run_id: string
          senior_pwd_flag?: boolean
          service_id_resolved?: string | null
          service_name_raw: string
          source_date: string
          source_row_no: number
          source_tab: string
          status?: string
          submission_date?: string | null
          validation_errors?: Json
          visit_group_key?: string | null
        }
        Update: {
          billed_amount?: number
          content_hash?: string | null
          created_at?: string
          first_name_raw?: string
          hmo_approval_date?: string | null
          id?: string
          last_name_raw?: string
          normalized_patient_name?: string
          or_number?: string | null
          paid_amount?: number
          patient_name_raw?: string
          payment_received_date?: string | null
          provider_id_resolved?: string | null
          provider_name_raw?: string
          reference_no?: string | null
          run_id?: string
          senior_pwd_flag?: boolean
          service_id_resolved?: string | null
          service_name_raw?: string
          source_date?: string
          source_row_no?: number
          source_tab?: string
          status?: string
          submission_date?: string | null
          validation_errors?: Json
          visit_group_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hmo_history_staging_provider_id_resolved_fkey"
            columns: ["provider_id_resolved"]
            isOneToOne: false
            referencedRelation: "hmo_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_history_staging_provider_id_resolved_fkey"
            columns: ["provider_id_resolved"]
            isOneToOne: false
            referencedRelation: "v_hmo_provider_summary"
            referencedColumns: ["provider_id"]
          },
          {
            foreignKeyName: "hmo_history_staging_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "hmo_import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_history_staging_service_id_resolved_fkey"
            columns: ["service_id_resolved"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      hmo_import_runs: {
        Row: {
          committed_at: string | null
          cutover_date: string
          error_count: number
          file_hash: string
          file_name: string
          finished_at: string | null
          id: string
          run_kind: string
          staging_count: number
          started_at: string
          summary: Json
          uploaded_by: string
          variance_override_reason: string | null
          warning_count: number
        }
        Insert: {
          committed_at?: string | null
          cutover_date: string
          error_count?: number
          file_hash: string
          file_name: string
          finished_at?: string | null
          id?: string
          run_kind: string
          staging_count?: number
          started_at?: string
          summary?: Json
          uploaded_by: string
          variance_override_reason?: string | null
          warning_count?: number
        }
        Update: {
          committed_at?: string | null
          cutover_date?: string
          error_count?: number
          file_hash?: string
          file_name?: string
          finished_at?: string | null
          id?: string
          run_kind?: string
          staging_count?: number
          started_at?: string
          summary?: Json
          uploaded_by?: string
          variance_override_reason?: string | null
          warning_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "hmo_import_runs_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      hmo_payment_allocations: {
        Row: {
          amount_php: number
          created_at: string
          id: string
          item_id: string
          payment_id: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount_php: number
          created_at?: string
          id?: string
          item_id: string
          payment_id: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount_php?: number
          created_at?: string
          id?: string
          item_id?: string
          payment_id?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hmo_payment_allocations_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "hmo_claim_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_payment_allocations_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_hmo_stuck"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "hmo_payment_allocations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_payment_allocations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "v_historical_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_payment_allocations_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      hmo_provider_aliases: {
        Row: {
          alias: string
          created_at: string
          created_by: string
          provider_id: string
        }
        Insert: {
          alias: string
          created_at?: string
          created_by: string
          provider_id: string
        }
        Update: {
          alias?: string
          created_at?: string
          created_by?: string
          provider_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hmo_provider_aliases_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_provider_aliases_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "hmo_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_provider_aliases_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "v_hmo_provider_summary"
            referencedColumns: ["provider_id"]
          },
        ]
      }
      hmo_providers: {
        Row: {
          contact_person_address: string | null
          contact_person_email: string | null
          contact_person_name: string | null
          contact_person_phone: string | null
          contract_end_date: string | null
          contract_start_date: string | null
          created_at: string
          due_days_for_invoice: number | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          unbilled_threshold_days: number
          updated_at: string
        }
        Insert: {
          contact_person_address?: string | null
          contact_person_email?: string | null
          contact_person_name?: string | null
          contact_person_phone?: string | null
          contract_end_date?: string | null
          contract_start_date?: string | null
          created_at?: string
          due_days_for_invoice?: number | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          unbilled_threshold_days?: number
          updated_at?: string
        }
        Update: {
          contact_person_address?: string | null
          contact_person_email?: string | null
          contact_person_name?: string | null
          contact_person_phone?: string | null
          contract_end_date?: string | null
          contract_start_date?: string | null
          created_at?: string
          due_days_for_invoice?: number | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          unbilled_threshold_days?: number
          updated_at?: string
        }
        Relationships: []
      }
      hmo_service_aliases: {
        Row: {
          alias: string
          created_at: string
          created_by: string
          service_id: string
        }
        Insert: {
          alias: string
          created_at?: string
          created_by: string
          service_id: string
        }
        Update: {
          alias?: string
          created_at?: string
          created_by?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hmo_service_aliases_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_service_aliases_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      inquiries: {
        Row: {
          called_at: string
          caller_name: string
          channel: string
          contact: string
          created_at: string
          created_by: string | null
          drop_reason: string | null
          id: string
          linked_appointment_id: string | null
          linked_visit_id: string | null
          notes: string | null
          received_by_id: string | null
          service_interest: string | null
          status: string
          updated_at: string
        }
        Insert: {
          called_at?: string
          caller_name: string
          channel: string
          contact: string
          created_at?: string
          created_by?: string | null
          drop_reason?: string | null
          id?: string
          linked_appointment_id?: string | null
          linked_visit_id?: string | null
          notes?: string | null
          received_by_id?: string | null
          service_interest?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          called_at?: string
          caller_name?: string
          channel?: string
          contact?: string
          created_at?: string
          created_by?: string | null
          drop_reason?: string | null
          id?: string
          linked_appointment_id?: string | null
          linked_visit_id?: string | null
          notes?: string | null
          received_by_id?: string | null
          service_interest?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inquiries_linked_appointment_id_fkey"
            columns: ["linked_appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inquiries_linked_visit_id_fkey"
            columns: ["linked_visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      je_year_counters: {
        Row: {
          fiscal_year: number
          next_n: number
        }
        Insert: {
          fiscal_year: number
          next_n?: number
        }
        Update: {
          fiscal_year?: number
          next_n?: number
        }
        Relationships: []
      }
      journal_entries: {
        Row: {
          created_at: string
          created_by: string | null
          description: string
          entry_number: string
          id: string
          notes: string | null
          posted_at: string | null
          posted_by: string | null
          posting_date: string
          reversed_by: string | null
          reverses: string | null
          source_id: string | null
          source_kind: Database["public"]["Enums"]["je_source_kind"]
          status: Database["public"]["Enums"]["je_status"]
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description: string
          entry_number: string
          id?: string
          notes?: string | null
          posted_at?: string | null
          posted_by?: string | null
          posting_date: string
          reversed_by?: string | null
          reverses?: string | null
          source_id?: string | null
          source_kind: Database["public"]["Enums"]["je_source_kind"]
          status?: Database["public"]["Enums"]["je_status"]
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string
          entry_number?: string
          id?: string
          notes?: string | null
          posted_at?: string | null
          posted_by?: string | null
          posting_date?: string
          reversed_by?: string | null
          reverses?: string | null
          source_id?: string | null
          source_kind?: Database["public"]["Enums"]["je_source_kind"]
          status?: Database["public"]["Enums"]["je_status"]
        }
        Relationships: [
          {
            foreignKeyName: "journal_entries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_reversed_by_fkey"
            columns: ["reversed_by"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_reverses_fkey"
            columns: ["reverses"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_lines: {
        Row: {
          account_id: string
          credit_php: number
          debit_php: number
          description: string | null
          entry_id: string
          id: string
          line_order: number
        }
        Insert: {
          account_id: string
          credit_php?: number
          debit_php?: number
          description?: string | null
          entry_id: string
          id?: string
          line_order: number
        }
        Update: {
          account_id?: string
          credit_php?: number
          debit_php?: number
          description?: string | null
          entry_id?: string
          id?: string
          line_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "journal_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "chart_of_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_lines_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      newsletter_campaigns: {
        Row: {
          body_html: string
          body_md: string
          created_at: string
          id: string
          recipient_count: number | null
          sent_at: string | null
          sent_by: string | null
          subject: string
        }
        Insert: {
          body_html: string
          body_md: string
          created_at?: string
          id?: string
          recipient_count?: number | null
          sent_at?: string | null
          sent_by?: string | null
          subject: string
        }
        Update: {
          body_html?: string
          body_md?: string
          created_at?: string
          id?: string
          recipient_count?: number | null
          sent_at?: string | null
          sent_by?: string | null
          subject?: string
        }
        Relationships: []
      }
      patients: {
        Row: {
          address: string | null
          birthdate: string | null
          consent_signed_at: string | null
          created_at: string
          created_by: string | null
          drm_id: string
          email: string | null
          first_name: string
          id: string
          is_historical: boolean
          is_repeat_patient: boolean
          last_name: string
          merged_at: string | null
          merged_into_id: string | null
          middle_name: string | null
          phone: string | null
          pre_registered: boolean
          preferred_release_medium: string | null
          referral_source: string | null
          referred_by_doctor: string | null
          senior_pwd_id_kind: string | null
          senior_pwd_id_number: string | null
          sex: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          birthdate?: string | null
          consent_signed_at?: string | null
          created_at?: string
          created_by?: string | null
          drm_id?: string
          email?: string | null
          first_name: string
          id?: string
          is_historical?: boolean
          is_repeat_patient?: boolean
          last_name: string
          merged_at?: string | null
          merged_into_id?: string | null
          middle_name?: string | null
          phone?: string | null
          pre_registered?: boolean
          preferred_release_medium?: string | null
          referral_source?: string | null
          referred_by_doctor?: string | null
          senior_pwd_id_kind?: string | null
          senior_pwd_id_number?: string | null
          sex?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          birthdate?: string | null
          consent_signed_at?: string | null
          created_at?: string
          created_by?: string | null
          drm_id?: string
          email?: string | null
          first_name?: string
          id?: string
          is_historical?: boolean
          is_repeat_patient?: boolean
          last_name?: string
          merged_at?: string | null
          merged_into_id?: string | null
          middle_name?: string | null
          phone?: string | null
          pre_registered?: boolean
          preferred_release_medium?: string | null
          referral_source?: string | null
          referred_by_doctor?: string | null
          senior_pwd_id_kind?: string | null
          senior_pwd_id_number?: string | null
          sex?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patients_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_method_account_map: {
        Row: {
          account_id: string
          created_at: string
          id: string
          notes: string | null
          payment_method: string
          updated_at: string
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          notes?: string | null
          payment_method: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          notes?: string | null
          payment_method?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_method_account_map_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "chart_of_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_php: number
          created_at: string
          id: string
          method: string | null
          notes: string | null
          received_at: string
          received_by: string
          reference_number: string | null
          visit_id: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount_php: number
          created_at?: string
          id?: string
          method?: string | null
          notes?: string | null
          received_at?: string
          received_by: string
          reference_number?: string | null
          visit_id: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount_php?: number
          created_at?: string
          id?: string
          method?: string | null
          notes?: string | null
          received_at?: string
          received_by?: string
          reference_number?: string | null
          visit_id?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      physician_schedule_overrides: {
        Row: {
          created_at: string
          end_time: string | null
          id: string
          override_on: string
          physician_id: string
          reason: string | null
          start_time: string | null
        }
        Insert: {
          created_at?: string
          end_time?: string | null
          id?: string
          override_on: string
          physician_id: string
          reason?: string | null
          start_time?: string | null
        }
        Update: {
          created_at?: string
          end_time?: string | null
          id?: string
          override_on?: string
          physician_id?: string
          reason?: string | null
          start_time?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "physician_schedule_overrides_physician_id_fkey"
            columns: ["physician_id"]
            isOneToOne: false
            referencedRelation: "physicians"
            referencedColumns: ["id"]
          },
        ]
      }
      physician_schedules: {
        Row: {
          created_at: string
          day_of_week: number
          end_time: string
          id: string
          notes: string | null
          physician_id: string
          start_time: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          created_at?: string
          day_of_week: number
          end_time: string
          id?: string
          notes?: string | null
          physician_id: string
          start_time: string
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          created_at?: string
          day_of_week?: number
          end_time?: string
          id?: string
          notes?: string | null
          physician_id?: string
          start_time?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "physician_schedules_physician_id_fkey"
            columns: ["physician_id"]
            isOneToOne: false
            referencedRelation: "physicians"
            referencedColumns: ["id"]
          },
        ]
      }
      physician_specialties: {
        Row: {
          code: string
          physician_id: string
        }
        Insert: {
          code: string
          physician_id: string
        }
        Update: {
          code?: string
          physician_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "physician_specialties_code_fkey"
            columns: ["code"]
            isOneToOne: false
            referencedRelation: "specialty_codes"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "physician_specialties_physician_id_fkey"
            columns: ["physician_id"]
            isOneToOne: false
            referencedRelation: "physicians"
            referencedColumns: ["id"]
          },
        ]
      }
      physicians: {
        Row: {
          bio: string | null
          created_at: string
          display_order: number
          full_name: string
          group_label: string | null
          id: string
          is_active: boolean
          photo_path: string | null
          slug: string
          specialty: string
          updated_at: string
        }
        Insert: {
          bio?: string | null
          created_at?: string
          display_order?: number
          full_name: string
          group_label?: string | null
          id?: string
          is_active?: boolean
          photo_path?: string | null
          slug: string
          specialty: string
          updated_at?: string
        }
        Update: {
          bio?: string | null
          created_at?: string
          display_order?: number
          full_name?: string
          group_label?: string | null
          id?: string
          is_active?: boolean
          photo_path?: string | null
          slug?: string
          specialty?: string
          updated_at?: string
        }
        Relationships: []
      }
      rate_limit_attempts: {
        Row: {
          attempted_at: string
          bucket: string
          id: number
          identifier: string
        }
        Insert: {
          attempted_at?: string
          bucket: string
          id?: number
          identifier: string
        }
        Update: {
          attempted_at?: string
          bucket?: string
          id?: number
          identifier?: string
        }
        Relationships: []
      }
      result_amendments: {
        Row: {
          amended_at: string
          amended_by: string
          amendment_seq: number
          id: string
          prior_file_size_bytes: number | null
          prior_notes: string | null
          prior_storage_path: string
          prior_uploaded_at: string
          prior_uploaded_by: string
          reason: string
          result_id: string
          test_request_id: string
        }
        Insert: {
          amended_at?: string
          amended_by: string
          amendment_seq: number
          id?: string
          prior_file_size_bytes?: number | null
          prior_notes?: string | null
          prior_storage_path: string
          prior_uploaded_at: string
          prior_uploaded_by: string
          reason: string
          result_id: string
          test_request_id: string
        }
        Update: {
          amended_at?: string
          amended_by?: string
          amendment_seq?: number
          id?: string
          prior_file_size_bytes?: number | null
          prior_notes?: string | null
          prior_storage_path?: string
          prior_uploaded_at?: string
          prior_uploaded_by?: string
          reason?: string
          result_id?: string
          test_request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "result_amendments_result_id_fkey"
            columns: ["result_id"]
            isOneToOne: false
            referencedRelation: "results"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "result_amendments_test_request_id_fkey"
            columns: ["test_request_id"]
            isOneToOne: false
            referencedRelation: "test_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "result_amendments_test_request_id_fkey"
            columns: ["test_request_id"]
            isOneToOne: false
            referencedRelation: "v_hmo_unbilled"
            referencedColumns: ["test_request_id"]
          },
        ]
      }
      result_template_param_ranges: {
        Row: {
          age_max_months: number | null
          age_min_months: number | null
          band_label: string
          created_at: string
          critical_high_conv: number | null
          critical_high_si: number | null
          critical_low_conv: number | null
          critical_low_si: number | null
          gender: string | null
          id: string
          parameter_id: string
          ref_high_conv: number | null
          ref_high_si: number | null
          ref_low_conv: number | null
          ref_low_si: number | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          age_max_months?: number | null
          age_min_months?: number | null
          band_label: string
          created_at?: string
          critical_high_conv?: number | null
          critical_high_si?: number | null
          critical_low_conv?: number | null
          critical_low_si?: number | null
          gender?: string | null
          id?: string
          parameter_id: string
          ref_high_conv?: number | null
          ref_high_si?: number | null
          ref_low_conv?: number | null
          ref_low_si?: number | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          age_max_months?: number | null
          age_min_months?: number | null
          band_label?: string
          created_at?: string
          critical_high_conv?: number | null
          critical_high_si?: number | null
          critical_low_conv?: number | null
          critical_low_si?: number | null
          gender?: string | null
          id?: string
          parameter_id?: string
          ref_high_conv?: number | null
          ref_high_si?: number | null
          ref_low_conv?: number | null
          ref_low_si?: number | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "result_template_param_ranges_parameter_id_fkey"
            columns: ["parameter_id"]
            isOneToOne: false
            referencedRelation: "result_template_params"
            referencedColumns: ["id"]
          },
        ]
      }
      result_template_params: {
        Row: {
          abnormal_values: string[] | null
          allowed_values: string[] | null
          created_at: string
          gender: string | null
          id: string
          input_type: string
          is_section_header: boolean
          parameter_name: string
          placeholder: string | null
          ref_high_conv: number | null
          ref_high_si: number | null
          ref_low_conv: number | null
          ref_low_si: number | null
          section: string | null
          si_to_conv_factor: number | null
          sort_order: number
          template_id: string
          unit_conv: string | null
          unit_si: string | null
        }
        Insert: {
          abnormal_values?: string[] | null
          allowed_values?: string[] | null
          created_at?: string
          gender?: string | null
          id?: string
          input_type: string
          is_section_header?: boolean
          parameter_name: string
          placeholder?: string | null
          ref_high_conv?: number | null
          ref_high_si?: number | null
          ref_low_conv?: number | null
          ref_low_si?: number | null
          section?: string | null
          si_to_conv_factor?: number | null
          sort_order: number
          template_id: string
          unit_conv?: string | null
          unit_si?: string | null
        }
        Update: {
          abnormal_values?: string[] | null
          allowed_values?: string[] | null
          created_at?: string
          gender?: string | null
          id?: string
          input_type?: string
          is_section_header?: boolean
          parameter_name?: string
          placeholder?: string | null
          ref_high_conv?: number | null
          ref_high_si?: number | null
          ref_low_conv?: number | null
          ref_low_si?: number | null
          section?: string | null
          si_to_conv_factor?: number | null
          sort_order?: number
          template_id?: string
          unit_conv?: string | null
          unit_si?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "result_template_params_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "result_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      result_templates: {
        Row: {
          created_at: string
          footer_notes: string | null
          header_notes: string | null
          id: string
          is_active: boolean
          layout: string
          service_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          footer_notes?: string | null
          header_notes?: string | null
          id?: string
          is_active?: boolean
          layout: string
          service_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          footer_notes?: string | null
          header_notes?: string | null
          id?: string
          is_active?: boolean
          layout?: string
          service_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "result_templates_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: true
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      result_values: {
        Row: {
          created_at: string
          flag: string | null
          id: string
          is_blank: boolean
          numeric_value_conv: number | null
          numeric_value_si: number | null
          parameter_id: string
          result_id: string
          select_value: string | null
          text_value: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          flag?: string | null
          id?: string
          is_blank?: boolean
          numeric_value_conv?: number | null
          numeric_value_si?: number | null
          parameter_id: string
          result_id: string
          select_value?: string | null
          text_value?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          flag?: string | null
          id?: string
          is_blank?: boolean
          numeric_value_conv?: number | null
          numeric_value_si?: number | null
          parameter_id?: string
          result_id?: string
          select_value?: string | null
          text_value?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "result_values_parameter_id_fkey"
            columns: ["parameter_id"]
            isOneToOne: false
            referencedRelation: "result_template_params"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "result_values_result_id_fkey"
            columns: ["result_id"]
            isOneToOne: false
            referencedRelation: "results"
            referencedColumns: ["id"]
          },
        ]
      }
      results: {
        Row: {
          amended_at: string | null
          amendment_count: number
          control_no: number | null
          created_at: string
          file_size_bytes: number | null
          finalised_at: string | null
          generation_kind: string
          id: string
          image_filename: string | null
          image_mime_type: string | null
          image_size_bytes: number | null
          image_storage_path: string | null
          image_uploaded_at: string | null
          image_uploaded_by: string | null
          notes: string | null
          storage_path: string | null
          test_request_id: string
          updated_at: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          amended_at?: string | null
          amendment_count?: number
          control_no?: number | null
          created_at?: string
          file_size_bytes?: number | null
          finalised_at?: string | null
          generation_kind?: string
          id?: string
          image_filename?: string | null
          image_mime_type?: string | null
          image_size_bytes?: number | null
          image_storage_path?: string | null
          image_uploaded_at?: string | null
          image_uploaded_by?: string | null
          notes?: string | null
          storage_path?: string | null
          test_request_id: string
          updated_at?: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          amended_at?: string | null
          amendment_count?: number
          control_no?: number | null
          created_at?: string
          file_size_bytes?: number | null
          finalised_at?: string | null
          generation_kind?: string
          id?: string
          image_filename?: string | null
          image_mime_type?: string | null
          image_size_bytes?: number | null
          image_storage_path?: string | null
          image_uploaded_at?: string | null
          image_uploaded_by?: string | null
          notes?: string | null
          storage_path?: string | null
          test_request_id?: string
          updated_at?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "results_image_uploaded_by_fkey"
            columns: ["image_uploaded_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_test_request_id_fkey"
            columns: ["test_request_id"]
            isOneToOne: true
            referencedRelation: "test_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_test_request_id_fkey"
            columns: ["test_request_id"]
            isOneToOne: true
            referencedRelation: "v_hmo_unbilled"
            referencedColumns: ["test_request_id"]
          },
        ]
      }
      service_price_history: {
        Row: {
          change_reason: string | null
          changed_by: string | null
          effective_from: string
          hmo_price_php: number | null
          id: number
          price_php: number | null
          senior_discount_php: number | null
          service_id: string
        }
        Insert: {
          change_reason?: string | null
          changed_by?: string | null
          effective_from?: string
          hmo_price_php?: number | null
          id?: never
          price_php?: number | null
          senior_discount_php?: number | null
          service_id: string
        }
        Update: {
          change_reason?: string | null
          changed_by?: string | null
          effective_from?: string
          hmo_price_php?: number | null
          id?: never
          price_php?: number | null
          senior_discount_php?: number | null
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_price_history_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          allow_concurrent: boolean
          code: string
          created_at: string
          description: string | null
          fasting_required: boolean
          hmo_price_php: number | null
          id: string
          is_active: boolean
          is_send_out: boolean
          kind: string
          name: string
          price_php: number
          requires_signoff: boolean
          requires_time_slot: boolean
          section: string | null
          send_out_lab: string | null
          senior_discount_php: number | null
          specialty_code: string | null
          turnaround_hours: number | null
          updated_at: string
        }
        Insert: {
          allow_concurrent?: boolean
          code: string
          created_at?: string
          description?: string | null
          fasting_required?: boolean
          hmo_price_php?: number | null
          id?: string
          is_active?: boolean
          is_send_out?: boolean
          kind?: string
          name: string
          price_php: number
          requires_signoff?: boolean
          requires_time_slot?: boolean
          section?: string | null
          send_out_lab?: string | null
          senior_discount_php?: number | null
          specialty_code?: string | null
          turnaround_hours?: number | null
          updated_at?: string
        }
        Update: {
          allow_concurrent?: boolean
          code?: string
          created_at?: string
          description?: string | null
          fasting_required?: boolean
          hmo_price_php?: number | null
          id?: string
          is_active?: boolean
          is_send_out?: boolean
          kind?: string
          name?: string
          price_php?: number
          requires_signoff?: boolean
          requires_time_slot?: boolean
          section?: string | null
          send_out_lab?: string | null
          senior_discount_php?: number | null
          specialty_code?: string | null
          turnaround_hours?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_specialty_code_fkey"
            columns: ["specialty_code"]
            isOneToOne: false
            referencedRelation: "specialty_codes"
            referencedColumns: ["code"]
          },
        ]
      }
      specialty_codes: {
        Row: {
          code: string
          created_at: string
          display_order: number
          label: string
        }
        Insert: {
          code: string
          created_at?: string
          display_order?: number
          label: string
        }
        Update: {
          code?: string
          created_at?: string
          display_order?: number
          label?: string
        }
        Relationships: []
      }
      staff_profiles: {
        Row: {
          created_at: string
          full_name: string
          id: string
          is_active: boolean
          prc_license_kind: string | null
          prc_license_no: string | null
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name: string
          id: string
          is_active?: boolean
          prc_license_kind?: string | null
          prc_license_no?: string | null
          role: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          is_active?: boolean
          prc_license_kind?: string | null
          prc_license_no?: string | null
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      subscribers: {
        Row: {
          consent_at: string
          consent_ip: unknown
          created_at: string
          email: string
          id: string
          source: string
          unsubscribe_token: string
          unsubscribed_at: string | null
        }
        Insert: {
          consent_at?: string
          consent_ip?: unknown
          created_at?: string
          email: string
          id?: string
          source: string
          unsubscribe_token?: string
          unsubscribed_at?: string | null
        }
        Update: {
          consent_at?: string
          consent_ip?: unknown
          created_at?: string
          email?: string
          id?: string
          source?: string
          unsubscribe_token?: string
          unsubscribed_at?: string | null
        }
        Relationships: []
      }
      sync_state: {
        Row: {
          key: string
          last_synced_at: string
          last_visit_id: string | null
          notes: string | null
          updated_at: string
        }
        Insert: {
          key: string
          last_synced_at: string
          last_visit_id?: string | null
          notes?: string | null
          updated_at?: string
        }
        Update: {
          key?: string
          last_synced_at?: string
          last_visit_id?: string | null
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      test_requests: {
        Row: {
          assigned_medtech_id: string | null
          assigned_to: string | null
          base_price_php: number | null
          cancelled_reason: string | null
          clinic_fee_php: number | null
          completed_at: string | null
          created_at: string
          discount_amount_php: number
          discount_kind: string | null
          doctor_pf_php: number | null
          final_price_php: number | null
          hmo_approval_date: string | null
          hmo_approved_amount_php: number | null
          hmo_authorization_no: string | null
          hmo_provider_id: string | null
          home_service_address: string | null
          home_service_fee_php: number | null
          id: string
          is_historical: boolean
          procedure_description: string | null
          receptionist_remarks: string | null
          release_medium: string | null
          released_at: string | null
          released_by: string | null
          requested_at: string
          requested_by: string
          service_id: string
          signed_off_at: string | null
          signed_off_by: string | null
          started_at: string | null
          status: string
          test_number: number | null
          updated_at: string
          visit_id: string
        }
        Insert: {
          assigned_medtech_id?: string | null
          assigned_to?: string | null
          base_price_php?: number | null
          cancelled_reason?: string | null
          clinic_fee_php?: number | null
          completed_at?: string | null
          created_at?: string
          discount_amount_php?: number
          discount_kind?: string | null
          doctor_pf_php?: number | null
          final_price_php?: number | null
          hmo_approval_date?: string | null
          hmo_approved_amount_php?: number | null
          hmo_authorization_no?: string | null
          hmo_provider_id?: string | null
          home_service_address?: string | null
          home_service_fee_php?: number | null
          id?: string
          is_historical?: boolean
          procedure_description?: string | null
          receptionist_remarks?: string | null
          release_medium?: string | null
          released_at?: string | null
          released_by?: string | null
          requested_at?: string
          requested_by: string
          service_id: string
          signed_off_at?: string | null
          signed_off_by?: string | null
          started_at?: string | null
          status?: string
          test_number?: number | null
          updated_at?: string
          visit_id: string
        }
        Update: {
          assigned_medtech_id?: string | null
          assigned_to?: string | null
          base_price_php?: number | null
          cancelled_reason?: string | null
          clinic_fee_php?: number | null
          completed_at?: string | null
          created_at?: string
          discount_amount_php?: number
          discount_kind?: string | null
          doctor_pf_php?: number | null
          final_price_php?: number | null
          hmo_approval_date?: string | null
          hmo_approved_amount_php?: number | null
          hmo_authorization_no?: string | null
          hmo_provider_id?: string | null
          home_service_address?: string | null
          home_service_fee_php?: number | null
          id?: string
          is_historical?: boolean
          procedure_description?: string | null
          receptionist_remarks?: string | null
          release_medium?: string | null
          released_at?: string | null
          released_by?: string | null
          requested_at?: string
          requested_by?: string
          service_id?: string
          signed_off_at?: string | null
          signed_off_by?: string | null
          started_at?: string | null
          status?: string
          test_number?: number | null
          updated_at?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_requests_assigned_medtech_id_fkey"
            columns: ["assigned_medtech_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_requests_hmo_provider_id_fkey"
            columns: ["hmo_provider_id"]
            isOneToOne: false
            referencedRelation: "hmo_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_requests_hmo_provider_id_fkey"
            columns: ["hmo_provider_id"]
            isOneToOne: false
            referencedRelation: "v_hmo_provider_summary"
            referencedColumns: ["provider_id"]
          },
          {
            foreignKeyName: "test_requests_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_requests_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      visit_pins: {
        Row: {
          created_at: string
          expires_at: string
          failed_attempts: number
          id: string
          last_used_at: string | null
          locked_until: string | null
          pin_hash: string
          visit_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          failed_attempts?: number
          id?: string
          last_used_at?: string | null
          locked_until?: string | null
          pin_hash: string
          visit_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          failed_attempts?: number
          id?: string
          last_used_at?: string | null
          locked_until?: string | null
          pin_hash?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "visit_pins_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: true
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      visits: {
        Row: {
          created_at: string
          created_by: string | null
          hmo_approval_date: string | null
          hmo_authorization_no: string | null
          hmo_provider_id: string | null
          id: string
          is_historical: boolean
          notes: string | null
          paid_php: number
          patient_id: string
          payment_status: string
          total_php: number
          updated_at: string
          visit_date: string
          visit_number: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          hmo_approval_date?: string | null
          hmo_authorization_no?: string | null
          hmo_provider_id?: string | null
          id?: string
          is_historical?: boolean
          notes?: string | null
          paid_php?: number
          patient_id: string
          payment_status?: string
          total_php?: number
          updated_at?: string
          visit_date?: string
          visit_number?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          hmo_approval_date?: string | null
          hmo_authorization_no?: string | null
          hmo_provider_id?: string | null
          id?: string
          is_historical?: boolean
          notes?: string | null
          paid_php?: number
          patient_id?: string
          payment_status?: string
          total_php?: number
          updated_at?: string
          visit_date?: string
          visit_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "visits_hmo_provider_id_fkey"
            columns: ["hmo_provider_id"]
            isOneToOne: false
            referencedRelation: "hmo_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_hmo_provider_id_fkey"
            columns: ["hmo_provider_id"]
            isOneToOne: false
            referencedRelation: "v_hmo_provider_summary"
            referencedColumns: ["provider_id"]
          },
          {
            foreignKeyName: "visits_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_historical_payments: {
        Row: {
          amount_php: number | null
          created_at: string | null
          id: string | null
          method: string | null
          notes: string | null
          received_at: string | null
          received_by: string | null
          reference_number: string | null
          visit_id: string | null
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount_php?: number | null
          created_at?: string | null
          id?: string | null
          method?: string | null
          notes?: string | null
          received_at?: string | null
          received_by?: string | null
          reference_number?: string | null
          visit_id?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount_php?: number | null
          created_at?: string | null
          id?: string | null
          method?: string | null
          notes?: string | null
          received_at?: string | null
          received_by?: string | null
          reference_number?: string | null
          visit_id?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      v_hmo_ar_aging: {
        Row: {
          bucket: string | null
          item_count: number | null
          provider_id: string | null
          provider_name: string | null
          total_php: number | null
        }
        Relationships: []
      }
      v_hmo_provider_summary: {
        Row: {
          due_days_for_invoice: number | null
          oldest_open_released_at: string | null
          paid_ytd_php: number | null
          patient_billed_ytd_php: number | null
          provider_id: string | null
          provider_name: string | null
          total_stuck_php: number | null
          total_unbilled_php: number | null
          total_unresolved_ar_php: number | null
          unbilled_threshold_days: number | null
          written_off_ytd_php: number | null
        }
        Insert: {
          due_days_for_invoice?: number | null
          oldest_open_released_at?: never
          paid_ytd_php?: never
          patient_billed_ytd_php?: never
          provider_id?: string | null
          provider_name?: string | null
          total_stuck_php?: never
          total_unbilled_php?: never
          total_unresolved_ar_php?: never
          unbilled_threshold_days?: number | null
          written_off_ytd_php?: never
        }
        Update: {
          due_days_for_invoice?: number | null
          oldest_open_released_at?: never
          paid_ytd_php?: never
          patient_billed_ytd_php?: never
          provider_id?: string | null
          provider_name?: string | null
          total_stuck_php?: never
          total_unbilled_php?: never
          total_unresolved_ar_php?: never
          unbilled_threshold_days?: number | null
          written_off_ytd_php?: never
        }
        Relationships: []
      }
      v_hmo_stuck: {
        Row: {
          batch_id: string | null
          days_since_submission: number | null
          item_id: string | null
          provider_id: string | null
          provider_name: string | null
          submitted_at: string | null
          unresolved_balance_php: number | null
        }
        Relationships: [
          {
            foreignKeyName: "hmo_claim_batches_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "hmo_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmo_claim_batches_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "v_hmo_provider_summary"
            referencedColumns: ["provider_id"]
          },
          {
            foreignKeyName: "hmo_claim_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "hmo_claim_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      v_hmo_unbilled: {
        Row: {
          billed_amount_php: number | null
          days_since_release: number | null
          past_threshold: boolean | null
          provider_id: string | null
          provider_name: string | null
          released_at: string | null
          test_request_id: string | null
          visit_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "test_requests_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_hmo_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "hmo_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_hmo_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "v_hmo_provider_summary"
            referencedColumns: ["provider_id"]
          },
        ]
      }
    }
    Functions: {
      bridge_replay_summary: {
        Args: { p_end: string; p_start: string }
        Returns: Json
      }
      coa_account_has_open_period_postings: {
        Args: { p_account_id: string }
        Returns: boolean
      }
      coa_uuid_for_code: { Args: { p_code: string }; Returns: string }
      commit_hmo_history_run: { Args: { p_run_id: string }; Returns: Json }
      current_patient_id: { Args: never; Returns: string }
      generate_drm_id: { Args: never; Returns: string }
      generate_visit_number: { Args: never; Returns: string }
      has_role: { Args: { roles: string[] }; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      je_next_number: { Args: { p_fiscal_year: number }; Returns: string }
      period_status_for: { Args: { p_date: string }; Returns: string }
      recompute_hmo_batch_status: {
        Args: { p_batch_id: string }
        Returns: undefined
      }
      recompute_hmo_item_paid_amount: {
        Args: { p_item_id: string }
        Returns: undefined
      }
      recompute_hmo_item_resolution_amounts: {
        Args: { p_item_id: string }
        Returns: undefined
      }
      resolve_ar_account: { Args: { p_is_hmo: boolean }; Returns: string }
      resolve_cash_account: { Args: { p_method: string }; Returns: string }
      resolve_discount_account: {
        Args: { p_service_kind: string }
        Returns: string
      }
      resolve_revenue_account: {
        Args: { p_service_kind: string }
        Returns: string
      }
      set_patient_context: {
        Args: { p_patient_id: string }
        Returns: undefined
      }
      staff_role: { Args: never; Returns: string }
    }
    Enums: {
      account_normal_balance: "debit" | "credit"
      account_type:
        | "asset"
        | "liability"
        | "equity"
        | "revenue"
        | "expense"
        | "contra_revenue"
        | "contra_expense"
        | "memo"
      je_source_kind:
        | "manual"
        | "payment"
        | "test_request"
        | "hmo_claim"
        | "doctor_payout"
        | "expense"
        | "payroll_run"
        | "opening_balance"
        | "reversal"
        | "hmo_claim_resolution"
        | "hmo_history_opening"
      je_status: "draft" | "posted" | "reversed"
      period_status: "open" | "closed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      account_normal_balance: ["debit", "credit"],
      account_type: [
        "asset",
        "liability",
        "equity",
        "revenue",
        "expense",
        "contra_revenue",
        "contra_expense",
        "memo",
      ],
      je_source_kind: [
        "manual",
        "payment",
        "test_request",
        "hmo_claim",
        "doctor_payout",
        "expense",
        "payroll_run",
        "opening_balance",
        "reversal",
        "hmo_claim_resolution",
        "hmo_history_opening",
      ],
      je_status: ["draft", "posted", "reversed"],
      period_status: ["open", "closed"],
    },
  },
} as const

